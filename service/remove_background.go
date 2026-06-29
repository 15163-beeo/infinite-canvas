package service

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	_ "image/gif"
	_ "image/jpeg"
	"image/png"
	"io"
	"log"
	"math"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
)

var (
	removeBackgroundWarmupOnce sync.Once
	removeBackgroundWorkerInst = &removeBackgroundWorker{}
)

type removeBackgroundWorker struct {
	mu     sync.Mutex
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
	stderr *lockedBuffer
}

type removeBackgroundWorkerRequest struct {
	Input      string              `json:"input"`
	Output     string              `json:"output"`
	MetaOutput string              `json:"meta_output"`
	FocusBox   *layerImageFocusBox `json:"focus_box,omitempty"`
}

type removeBackgroundWorkerResponse struct {
	Ready bool   `json:"ready,omitempty"`
	OK    bool   `json:"ok,omitempty"`
	Error string `json:"error,omitempty"`
}

type RemoveBackgroundResult struct {
	Image          []byte
	OriginalWidth  int
	OriginalHeight int
	ProductOffsetX int
	ProductOffsetY int
	ProductWidth   int
	ProductHeight  int
}

type lockedBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (buf *lockedBuffer) Write(data []byte) (int, error) {
	buf.mu.Lock()
	defer buf.mu.Unlock()
	return buf.buffer.Write(data)
}

func (buf *lockedBuffer) String() string {
	buf.mu.Lock()
	defer buf.mu.Unlock()
	return buf.buffer.String()
}

func StartRemoveBackgroundWarmup() {
	removeBackgroundWarmupOnce.Do(func() {
		go func() {
			timeout := time.Duration(max(5, config.Cfg.RemoveBGTimeout)) * time.Second
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			defer cancel()
			if _, err := ensureRemoveBackgroundWorker(ctx); err != nil {
				log.Printf("remove background warmup failed: %v", err)
			}
		}()
	})
}

func RemoveBackground(ctx context.Context, filename string, contentType string, data []byte, options ...LayerImageOptions) (*RemoveBackgroundResult, error) {
	if len(data) == 0 {
		return nil, safeMessageError{message: "去背景图片不能为空"}
	}
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(contentType)), "image/") {
		return nil, safeMessageError{message: "去背景只支持图片文件"}
	}

	if aliyunImageSegConfigured() {
		var result *RemoveBackgroundResult
		var err error
		if len(options) > 0 {
			if focusBox, focusErr := detectLayerImageFocusBoxForOriginal(ctx, data, contentType, options[0]); focusErr != nil {
				log.Printf("remove background focus detection skipped: %v", focusErr)
			} else if focusBox != nil {
				result, err = removeBackgroundWithFocusedAliyunImageSeg(ctx, filename, data, focusBox)
				if err != nil {
					log.Printf("focused aliyun imageseg remove background failed, fallback: %v", err)
				}
			}
		}
		if result == nil {
			result, err = removeBackgroundWithAliyunImageSeg(ctx, filename, contentType, data)
		}
		if err == nil {
			return result, nil
		}
		log.Printf("aliyun imageseg remove background failed, fallback: %v", err)
	}

	if len(options) > 0 {
		if strings.TrimSpace(options[0].Model) != "" {
			return removeBackgroundWithImageModel(ctx, filename, contentType, data, options[0])
		}
	}

	image, meta, err := removeBackgroundWithLocalProcess(ctx, filename, contentType, data, nil)
	if err != nil {
		return nil, err
	}
	return removeBackgroundResultFromMeta(image, meta), nil
}

func removeBackgroundResultFromMeta(image []byte, meta layerImageMeta) *RemoveBackgroundResult {
	return &RemoveBackgroundResult{
		Image:          image,
		OriginalWidth:  meta.OriginalWidth,
		OriginalHeight: meta.OriginalHeight,
		ProductOffsetX: meta.ProductOffsetX,
		ProductOffsetY: meta.ProductOffsetY,
		ProductWidth:   meta.ProductWidth,
		ProductHeight:  meta.ProductHeight,
	}
}

func removeBackgroundWithLocalProcess(ctx context.Context, filename string, contentType string, data []byte, focusBox *layerImageFocusBox) ([]byte, layerImageMeta, error) {

	inputFile, err := os.CreateTemp("", "remove-bg-input-*"+imageExtByMime(contentType, filename))
	if err != nil {
		return nil, layerImageMeta{}, err
	}
	inputPath := inputFile.Name()
	defer os.Remove(inputPath)
	if _, err := inputFile.Write(data); err != nil {
		_ = inputFile.Close()
		return nil, layerImageMeta{}, err
	}
	if err := inputFile.Close(); err != nil {
		return nil, layerImageMeta{}, err
	}

	outputFile, err := os.CreateTemp("", "remove-bg-output-*.png")
	if err != nil {
		return nil, layerImageMeta{}, err
	}
	outputPath := outputFile.Name()
	_ = outputFile.Close()
	defer os.Remove(outputPath)

	metaFile, err := os.CreateTemp("", "remove-bg-meta-*.json")
	if err != nil {
		return nil, layerImageMeta{}, err
	}
	metaPath := metaFile.Name()
	_ = metaFile.Close()
	defer os.Remove(metaPath)

	if err := runRemoveBackgroundProcess(ctx, inputPath, outputPath, metaPath, focusBox); err != nil {
		return nil, layerImageMeta{}, err
	}

	return readRemoveBackgroundArtifacts(outputPath, metaPath)
}

func removeBackgroundWithImageModel(ctx context.Context, filename string, contentType string, data []byte, options LayerImageOptions) (*RemoveBackgroundResult, error) {
	modelName := strings.TrimSpace(options.Model)
	if modelName == "" {
		return nil, errors.New("去背景未配置图像模型")
	}
	channel, err := removeBackgroundImageModelChannel(modelName, options)
	if err != nil {
		return nil, err
	}

	result, err := requestRemoveBackgroundImageEdit(ctx, filename, contentType, data, modelName, channel)
	if err != nil {
		return nil, err
	}

	normalized, normalizeErr := normalizeTransparentCutout(result, data)
	if normalizeErr == nil {
		return normalized, nil
	}
	return nil, normalizeErr
}

func removeBackgroundImageModelChannel(modelName string, options LayerImageOptions) (model.ModelChannel, error) {
	channelMode := strings.ToLower(strings.TrimSpace(options.ChannelMode))
	if channelMode == "local" {
		channel := normalizeModelChannel(model.ModelChannel{
			ID:      strings.TrimSpace(options.ChannelID),
			Name:    "用户本地直连",
			BaseURL: strings.TrimSpace(options.BaseURL),
			APIKey:  strings.TrimSpace(options.APIKey),
			Models:  []string{modelName},
			Enabled: true,
		})
		if channel.BaseURL == "" {
			return model.ModelChannel{}, safeMessageError{message: "去背景缺少本地接口地址"}
		}
		if channel.APIKey == "" {
			return model.ModelChannel{}, safeMessageError{message: "去背景缺少 API Key"}
		}
		return channel, nil
	}
	return SelectModelChannelForModel(modelName, strings.TrimSpace(options.ChannelID))
}

func requestRemoveBackgroundImageEdit(ctx context.Context, filename string, contentType string, data []byte, modelName string, channel model.ModelChannel) ([]byte, error) {
	return requestRemoveBackgroundImageEditVariant(ctx, filename, contentType, data, modelName, channel, false)
}

func requestRemoveBackgroundImageEditVariant(ctx context.Context, filename string, contentType string, data []byte, modelName string, channel model.ModelChannel, requestTransparentBackground bool) ([]byte, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	fields := map[string]string{
		"model":         modelName,
		"prompt":        removeBackgroundImagePrompt(),
		"output_format": "png",
	}
	if requestTransparentBackground {
		fields["background"] = "transparent"
	}
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			return nil, err
		}
	}
	part, err := writer.CreateFormFile("image", safeRemoveBackgroundFilename(filename, contentType))
	if err != nil {
		return nil, err
	}
	if _, err := part.Write(data); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, BuildModelChannelURL(channel, "/images/edits"), bytes.NewReader(body.Bytes()))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	request.Header.Set("Content-Type", writer.FormDataContentType())

	response, err := HTTPClientForChannel(channel).Do(request)
	if err != nil {
		return nil, safeMessageError{message: "去背景图像模型请求失败：" + err.Error()}
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode >= http.StatusBadRequest {
		return nil, imageEditError{status: response.StatusCode, body: responseBody}
	}
	result, err := parseImageEditResult(ctx, channel, responseBody)
	if err != nil {
		return nil, safeMessageError{message: "去背景结果解析失败：" + err.Error()}
	}
	return result, nil
}

func removeBackgroundImagePrompt() string {
	return `请做严格、通用的商品去背景抠图。只保留真实商品主体，删除所有背景、色块、白底、文案区、边框、场景和多余留白。
商品本体、包装、包装上的印刷文字和图案都属于主体，必须保留。
把主体放在纯色抠图背景上，背景必须是均匀纯绿色 #00FF00，不要棋盘格、不要白底、不要灰底、不要阴影。
不要重绘，不要美化，不要改字，不要添加新元素。输出 PNG。`
}

type imageEditError struct {
	status int
	body   []byte
}

func (err imageEditError) Error() string {
	message := strings.TrimSpace(extractImageEditErrorMessage(err.body))
	if message == "" {
		message = strings.TrimSpace(string(err.body))
	}
	if message == "" {
		message = http.StatusText(err.status)
	}
	return fmt.Sprintf("去背景图像模型失败（%d）：%s", err.status, message)
}

func (err imageEditError) SafeMessage() string {
	return err.Error()
}

func extractImageEditErrorMessage(body []byte) string {
	var payload struct {
		Error   any    `json:"error"`
		Msg     string `json:"msg"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}
	if strings.TrimSpace(payload.Msg) != "" {
		return strings.TrimSpace(payload.Msg)
	}
	if strings.TrimSpace(payload.Message) != "" {
		return strings.TrimSpace(payload.Message)
	}
	switch value := payload.Error.(type) {
	case string:
		return strings.TrimSpace(value)
	case map[string]any:
		for _, key := range []string{"message", "msg", "detail"} {
			if text, ok := value[key].(string); ok && strings.TrimSpace(text) != "" {
				return strings.TrimSpace(text)
			}
		}
	}
	return ""
}

func shouldRetryImageEditWithoutTransparentParam(err error) bool {
	var editErr imageEditError
	if !errors.As(err, &editErr) {
		return false
	}
	if editErr.status != http.StatusBadRequest && editErr.status != http.StatusUnprocessableEntity {
		return false
	}
	text := strings.ToLower(string(editErr.body))
	return strings.Contains(text, "background") || strings.Contains(text, "transparent")
}

func parseImageEditResult(ctx context.Context, channel model.ModelChannel, body []byte) ([]byte, error) {
	var payload struct {
		Data []struct {
			B64JSON string `json:"b64_json"`
			URL     string `json:"url"`
		} `json:"data"`
		Error any    `json:"error"`
		Msg   string `json:"msg"`
		Code  int    `json:"code"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	if payload.Code != 0 {
		return nil, fmt.Errorf("去背景图像模型返回异常：%s", strings.TrimSpace(payload.Msg))
	}
	for _, item := range payload.Data {
		if strings.TrimSpace(item.B64JSON) != "" {
			return base64.StdEncoding.DecodeString(stripDataURLPrefix(item.B64JSON))
		}
		if strings.TrimSpace(item.URL) != "" {
			return downloadImageEditURL(ctx, channel, strings.TrimSpace(item.URL))
		}
	}
	return nil, errors.New("去背景图像模型没有返回图片")
}

func stripDataURLPrefix(value string) string {
	if comma := strings.Index(value, ","); strings.HasPrefix(value, "data:") && comma >= 0 {
		return value[comma+1:]
	}
	return value
}

func downloadImageEditURL(ctx context.Context, channel model.ModelChannel, url string) ([]byte, error) {
	if strings.HasPrefix(url, "data:image/") {
		return base64.StdEncoding.DecodeString(stripDataURLPrefix(url))
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	client := *HTTPClientForChannel(channel)
	if client.Timeout <= 0 {
		client.Timeout = 600 * time.Second
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, safeMessageError{message: "去背景结果下载失败：" + err.Error()}
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode >= http.StatusBadRequest {
		return nil, fmt.Errorf("去背景结果下载失败：%d", response.StatusCode)
	}
	return body, nil
}

func normalizeTransparentCutout(data []byte, sourceData []byte) (*RemoveBackgroundResult, error) {
	image.RegisterFormat("png", "png", png.Decode, png.DecodeConfig)
	decoded, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	sourceImage, sourceWidth, sourceHeight := decodeNRGBAImage(sourceData)
	bounds := decoded.Bounds()
	rgba := image.NewNRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	draw.Draw(rgba, rgba.Bounds(), decoded, bounds.Min, draw.Src)

	bbox, transparentPixels := alphaBounds(rgba, 10)
	if bbox.Empty() {
		return nil, errors.New("去背景图像模型返回空透明图")
	}
	totalPixels := rgba.Bounds().Dx() * rgba.Bounds().Dy()
	usedChromaKey := false
	if totalPixels > 0 && float64(transparentPixels)/float64(totalPixels) < 0.01 {
		if cutout, ok := transparentCutoutFromOpaqueChromaKey(rgba); ok {
			rgba = cutout
			usedChromaKey = true
			bbox, _ = alphaBounds(rgba, 10)
			if bbox.Empty() {
				return nil, errors.New("去背景图像模型返回空透明图")
			}
		} else if cutout, ok := transparentCutoutFromOpaqueCheckerboard(rgba); ok {
			rgba = cutout
			bbox, _ = alphaBounds(rgba, 10)
			if bbox.Empty() {
				return nil, errors.New("去背景图像模型返回空透明图")
			}
		} else if cutout, ok := transparentCutoutFromOpaqueFlatBackground(rgba); ok {
			rgba = cutout
			bbox, _ = alphaBounds(rgba, 10)
			if bbox.Empty() {
				return nil, errors.New("去背景图像模型返回空透明图")
			}
		} else {
			return nil, errors.New("去背景图像模型未返回透明背景")
		}
	}

	rgba = healInteriorTransparentHoles(rgba, sourceImage)
	if usedChromaKey {
		rgba = removeChromaKeyFringe(rgba)
	}
	bbox, _ = alphaBounds(rgba, 10)
	if bbox.Empty() {
		return nil, errors.New("去背景图像模型返回空透明图")
	}
	cropped := rgba.SubImage(bbox).(*image.NRGBA)
	var output bytes.Buffer
	if err := png.Encode(&output, cropped); err != nil {
		return nil, err
	}
	resultWidth := max(1, rgba.Bounds().Dx())
	resultHeight := max(1, rgba.Bounds().Dy())
	if sourceWidth <= 0 || sourceHeight <= 0 {
		sourceWidth = resultWidth
		sourceHeight = resultHeight
	}
	scaleX := float64(sourceWidth) / float64(resultWidth)
	scaleY := float64(sourceHeight) / float64(resultHeight)
	return &RemoveBackgroundResult{
		Image:          output.Bytes(),
		OriginalWidth:  sourceWidth,
		OriginalHeight: sourceHeight,
		ProductOffsetX: int(math.Round(float64(bbox.Min.X) * scaleX)),
		ProductOffsetY: int(math.Round(float64(bbox.Min.Y) * scaleY)),
		ProductWidth:   max(1, int(math.Round(float64(bbox.Dx())*scaleX))),
		ProductHeight:  max(1, int(math.Round(float64(bbox.Dy())*scaleY))),
	}, nil
}

func removeBackgroundResultNeedsRetry(result *RemoveBackgroundResult) bool {
	if result == nil || len(result.Image) == 0 {
		return false
	}
	decoded, _, err := image.Decode(bytes.NewReader(result.Image))
	if err != nil {
		return false
	}
	bounds := decoded.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()
	if width < 80 || height < 80 {
		return false
	}
	rgba := image.NewNRGBA(image.Rect(0, 0, width, height))
	draw.Draw(rgba, rgba.Bounds(), decoded, bounds.Min, draw.Src)
	check := image.Rect(width/4, height/3, width*3/4, height*5/6)
	transparent := 0
	opaque := 0
	for y := check.Min.Y; y < check.Max.Y; y++ {
		for x := check.Min.X; x < check.Max.X; x++ {
			alpha := rgba.NRGBAAt(x, y).A
			if alpha < 10 {
				transparent++
			} else if alpha >= 220 {
				opaque++
			}
		}
	}
	total := max(1, check.Dx()*check.Dy())
	transparentRatio := float64(transparent) / float64(total)
	opaqueRatio := float64(opaque) / float64(total)
	return transparentRatio > 0.32 && opaqueRatio > 0.04
}

func transparentCutoutFromOpaqueChromaKey(source *image.NRGBA) (*image.NRGBA, bool) {
	bounds := source.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()
	if width < 16 || height < 16 {
		return nil, false
	}
	border := sampleNRGBABorder(source)
	if len(border) == 0 {
		return nil, false
	}
	chromaSamples := make([]colorNRGBA, 0, len(border))
	for _, sample := range border {
		if isChromaKeyColor(sample, 72) {
			chromaSamples = append(chromaSamples, sample)
		}
	}
	if len(chromaSamples) < max(24, len(border)*3/5) {
		return nil, false
	}
	background := medianColor(chromaSamples)
	if !isChromaKeyColor(background, 58) {
		return nil, false
	}

	output := image.NewNRGBA(bounds)
	draw.Draw(output, bounds, source, bounds.Min, draw.Src)
	visited := make([]bool, width*height)
	queue := make([]image.Point, 0, width*2+height*2)
	add := func(x int, y int) {
		if x < bounds.Min.X || x >= bounds.Max.X || y < bounds.Min.Y || y >= bounds.Max.Y {
			return
		}
		index := (y-bounds.Min.Y)*width + (x - bounds.Min.X)
		if visited[index] {
			return
		}
		pixel := source.NRGBAAt(x, y)
		if pixel.A < 12 || !matchesChromaKeyPixel(nrgbaToColor(pixel), background) {
			return
		}
		visited[index] = true
		queue = append(queue, image.Point{X: x, Y: y})
	}
	for x := bounds.Min.X; x < bounds.Max.X; x++ {
		add(x, bounds.Min.Y)
		add(x, bounds.Max.Y-1)
	}
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		add(bounds.Min.X, y)
		add(bounds.Max.X-1, y)
	}
	for head := 0; head < len(queue); head++ {
		point := queue[head]
		pixel := output.NRGBAAt(point.X, point.Y)
		pixel.A = 0
		output.SetNRGBA(point.X, point.Y, pixel)
		add(point.X-1, point.Y)
		add(point.X+1, point.Y)
		add(point.X, point.Y-1)
		add(point.X, point.Y+1)
	}
	if len(queue) < max(200, width*height/20) {
		return nil, false
	}
	if bbox, transparentPixels := alphaBounds(output, 10); bbox.Empty() || transparentPixels < width*height/20 {
		return nil, false
	}
	return output, true
}

func isChromaKeyColor(color colorNRGBA, margin float64) bool {
	return color.G >= 145 && color.G-color.R >= margin && color.G-color.B >= margin
}

func matchesChromaKeyPixel(color colorNRGBA, background colorNRGBA) bool {
	if !isChromaKeyColor(color, 18) {
		return false
	}
	return colorDistanceNRGBA(color, background) <= 175
}

func removeChromaKeyFringe(source *image.NRGBA) *image.NRGBA {
	bounds := source.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()
	if width < 3 || height < 3 {
		return source
	}
	output := image.NewNRGBA(bounds)
	draw.Draw(output, bounds, source, bounds.Min, draw.Src)
	visited := make([]bool, width*height)
	queue := make([]image.Point, 0, width*2+height*2)
	add := func(x int, y int) {
		if x < bounds.Min.X || x >= bounds.Max.X || y < bounds.Min.Y || y >= bounds.Max.Y {
			return
		}
		index := (y-bounds.Min.Y)*width + (x - bounds.Min.X)
		if visited[index] {
			return
		}
		pixel := output.NRGBAAt(x, y)
		if pixel.A >= 12 && !isChromaFringePixel(pixel) {
			return
		}
		visited[index] = true
		if pixel.A >= 12 {
			pixel.A = 0
			output.SetNRGBA(x, y, pixel)
		}
		queue = append(queue, image.Point{X: x, Y: y})
	}
	for x := bounds.Min.X; x < bounds.Max.X; x++ {
		add(x, bounds.Min.Y)
		add(x, bounds.Max.Y-1)
	}
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		add(bounds.Min.X, y)
		add(bounds.Max.X-1, y)
	}
	for head := 0; head < len(queue); head++ {
		point := queue[head]
		add(point.X-1, point.Y)
		add(point.X+1, point.Y)
		add(point.X, point.Y-1)
		add(point.X, point.Y+1)
	}
	return output
}

func isChromaFringePixel(pixel color.NRGBA) bool {
	if pixel.A < 12 {
		return true
	}
	color := nrgbaToColor(pixel)
	return isChromaKeyColor(color, 18) && color.G >= 120 && colorDistanceNRGBA(color, colorNRGBA{R: 0, G: 255, B: 0}) <= 185
}

func transparentCutoutFromOpaqueCheckerboard(source *image.NRGBA) (*image.NRGBA, bool) {
	bounds := source.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()
	if width < 48 || height < 48 {
		return nil, false
	}
	tileSize, darkTone, lightTone, ok := detectCheckerboardBackdrop(source)
	if !ok {
		return nil, false
	}

	output := image.NewNRGBA(bounds)
	draw.Draw(output, bounds, source, bounds.Min, draw.Src)
	visited := make([]bool, width*height)
	queue := make([]image.Point, 0, width*2+height*2)
	add := func(x int, y int) {
		if x < bounds.Min.X || x >= bounds.Max.X || y < bounds.Min.Y || y >= bounds.Max.Y {
			return
		}
		index := (y-bounds.Min.Y)*width + (x - bounds.Min.X)
		if visited[index] {
			return
		}
		visited[index] = true
		if !matchesCheckerboardPixel(source, x, y, tileSize, darkTone, lightTone) {
			return
		}
		queue = append(queue, image.Point{X: x, Y: y})
	}

	for x := bounds.Min.X; x < bounds.Max.X; x++ {
		add(x, bounds.Min.Y)
		add(x, bounds.Max.Y-1)
	}
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		add(bounds.Min.X, y)
		add(bounds.Max.X-1, y)
	}
	for head := 0; head < len(queue); head++ {
		point := queue[head]
		pixel := output.NRGBAAt(point.X, point.Y)
		pixel.A = 0
		output.SetNRGBA(point.X, point.Y, pixel)
		add(point.X-1, point.Y)
		add(point.X+1, point.Y)
		add(point.X, point.Y-1)
		add(point.X, point.Y+1)
	}

	if len(queue) < max(400, width*height/18) {
		return nil, false
	}
	bbox, transparentPixels := alphaBounds(output, 10)
	if bbox.Empty() || transparentPixels < width*height/18 {
		return nil, false
	}
	return output, true
}

func detectCheckerboardBackdrop(source *image.NRGBA) (int, float64, float64, bool) {
	bounds := source.Bounds()
	height := bounds.Dy()
	rows := []int{
		bounds.Min.Y,
		bounds.Min.Y + min(height-1, max(1, height/100)),
		bounds.Max.Y - 1,
	}
	type candidate struct {
		tile  int
		dark  float64
		light float64
	}
	candidates := []candidate{}
	for _, y := range rows {
		if tile, dark, light, ok := detectCheckerboardRunsOnRow(source, y); ok {
			candidates = append(candidates, candidate{tile: tile, dark: dark, light: light})
		}
	}
	if len(candidates) == 0 {
		return 0, 0, 0, false
	}
	sort.Slice(candidates, func(i int, j int) bool {
		return candidates[i].tile < candidates[j].tile
	})
	tile := candidates[len(candidates)/2].tile
	darks := make([]float64, 0, len(candidates))
	lights := make([]float64, 0, len(candidates))
	for _, item := range candidates {
		darks = append(darks, item.dark)
		lights = append(lights, item.light)
	}
	dark := medianFloat(darks)
	light := medianFloat(lights)
	if tile < 8 || tile > 80 || light-dark < 10 || dark < 180 || light < 230 {
		return 0, 0, 0, false
	}
	return tile, dark, light, true
}

func detectCheckerboardRunsOnRow(source *image.NRGBA, y int) (int, float64, float64, bool) {
	bounds := source.Bounds()
	width := bounds.Dx()
	if y < bounds.Min.Y || y >= bounds.Max.Y {
		return 0, 0, 0, false
	}
	tones := make([]float64, 0, width)
	for x := bounds.Min.X; x < bounds.Max.X; x++ {
		pixel := source.NRGBAAt(x, y)
		if !isNeutralCheckerPixel(pixel) {
			return 0, 0, 0, false
		}
		tones = append(tones, (float64(pixel.R)+float64(pixel.G)+float64(pixel.B))/3)
	}
	low := percentileFloat(tones, 0.20)
	high := percentileFloat(tones, 0.80)
	if high-low < 10 {
		return 0, 0, 0, false
	}
	mid := (low + high) / 2
	runs := []int{}
	currentTone := tones[0] >= mid
	runStart := 0
	for index, tone := range tones[1:] {
		nextTone := tone >= mid
		if nextTone == currentTone {
			continue
		}
		runs = append(runs, index+1-runStart)
		runStart = index + 1
		currentTone = nextTone
	}
	runs = append(runs, len(tones)-runStart)
	filtered := make([]float64, 0, len(runs))
	for _, run := range runs {
		if run >= 8 && run <= 80 {
			filtered = append(filtered, float64(run))
		}
	}
	if len(filtered) < 6 {
		return 0, 0, 0, false
	}
	return int(math.Round(medianFloat(filtered))), low, high, true
}

func isNeutralCheckerPixel(pixel color.NRGBA) bool {
	maxChannel := max(int(pixel.R), max(int(pixel.G), int(pixel.B)))
	minChannel := min(int(pixel.R), min(int(pixel.G), int(pixel.B)))
	brightness := (int(pixel.R) + int(pixel.G) + int(pixel.B)) / 3
	return pixel.A >= 240 && maxChannel-minChannel <= 14 && brightness >= 180
}

func matchesCheckerboardPixel(source *image.NRGBA, absoluteX int, absoluteY int, tileSize int, darkTone float64, lightTone float64) bool {
	bounds := source.Bounds()
	pixel := source.NRGBAAt(absoluteX, absoluteY)
	if !isNeutralCheckerPixel(pixel) {
		return false
	}
	x := absoluteX - bounds.Min.X
	y := absoluteY - bounds.Min.Y
	brightness := (float64(pixel.R) + float64(pixel.G) + float64(pixel.B)) / 3
	expected := darkTone
	if ((x/tileSize)+(y/tileSize))%2 == 1 {
		expected = lightTone
	}
	if math.Abs(brightness-expected) <= 11 && matchesLocalCheckerboardPixel(source, absoluteX, absoluteY, tileSize, brightness, darkTone, lightTone) {
		return true
	}
	return matchesLocalCheckerboardPixel(source, absoluteX, absoluteY, tileSize, brightness, darkTone, lightTone)
}

func matchesLocalCheckerboardPixel(source *image.NRGBA, x int, y int, tileSize int, brightness float64, darkTone float64, lightTone float64) bool {
	currentIsLight := math.Abs(brightness-lightTone) <= math.Abs(brightness-darkTone)
	targetTone := darkTone
	oppositeTone := lightTone
	if currentIsLight {
		targetTone = lightTone
		oppositeTone = darkTone
	}
	if math.Abs(brightness-targetTone) > 13 {
		return false
	}

	bounds := source.Bounds()
	score := 0
	oppositeScore := 0
	for _, offset := range []image.Point{
		{X: tileSize, Y: 0},
		{X: -tileSize, Y: 0},
		{X: 0, Y: tileSize},
		{X: 0, Y: -tileSize},
	} {
		nx := x + offset.X
		ny := y + offset.Y
		if nx < bounds.Min.X || nx >= bounds.Max.X || ny < bounds.Min.Y || ny >= bounds.Max.Y {
			continue
		}
		if checkerPixelBrightnessClose(source.NRGBAAt(nx, ny), oppositeTone, 13) {
			score++
			oppositeScore++
		}
	}
	for _, offset := range []image.Point{
		{X: tileSize * 2, Y: 0},
		{X: -tileSize * 2, Y: 0},
		{X: 0, Y: tileSize * 2},
		{X: 0, Y: -tileSize * 2},
	} {
		nx := x + offset.X
		ny := y + offset.Y
		if nx < bounds.Min.X || nx >= bounds.Max.X || ny < bounds.Min.Y || ny >= bounds.Max.Y {
			continue
		}
		if checkerPixelBrightnessClose(source.NRGBAAt(nx, ny), targetTone, 13) {
			score++
		}
	}
	return oppositeScore >= 1 && score >= 2
}

func checkerPixelBrightnessClose(pixel color.NRGBA, tone float64, tolerance float64) bool {
	if !isNeutralCheckerPixel(pixel) {
		return false
	}
	brightness := (float64(pixel.R) + float64(pixel.G) + float64(pixel.B)) / 3
	return math.Abs(brightness-tone) <= tolerance
}

func decodeNRGBAImage(data []byte) (*image.NRGBA, int, int) {
	decoded, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, 0, 0
	}
	bounds := decoded.Bounds()
	rgba := image.NewNRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	draw.Draw(rgba, rgba.Bounds(), decoded, bounds.Min, draw.Src)
	return rgba, rgba.Bounds().Dx(), rgba.Bounds().Dy()
}

func healInteriorTransparentHoles(source *image.NRGBA, original *image.NRGBA) *image.NRGBA {
	bbox, _ := alphaBounds(source, 10)
	if bbox.Empty() {
		return source
	}
	bounds := source.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()
	visited := make([]bool, width*height)
	output := image.NewNRGBA(bounds)
	draw.Draw(output, bounds, source, bounds.Min, draw.Src)

	sourceCompatible := original != nil && sameAspectRatio(width, height, original.Bounds().Dx(), original.Bounds().Dy())
	bboxArea := max(1, bbox.Dx()*bbox.Dy())
	indexOf := func(x int, y int) int {
		return (y-bounds.Min.Y)*width + (x - bounds.Min.X)
	}

	for y := bbox.Min.Y; y < bbox.Max.Y; y++ {
		for x := bbox.Min.X; x < bbox.Max.X; x++ {
			index := indexOf(x, y)
			if visited[index] || output.NRGBAAt(x, y).A >= 10 {
				continue
			}
			component, touchesEdge := collectTransparentComponent(output, bbox, x, y, visited)
			if touchesEdge || len(component) == 0 || len(component) > bboxArea*35/100 {
				continue
			}
			fallbackColor, hasFallback := averageBoundaryColor(output, component)
			for _, point := range component {
				pixel := output.NRGBAAt(point.X, point.Y)
				if sourceCompatible {
					pixel = mappedSourceColor(original, point.X-bounds.Min.X, point.Y-bounds.Min.Y, width, height)
				} else if isInvisibleBlack(pixel) && hasFallback {
					pixel.R = fallbackColor.R
					pixel.G = fallbackColor.G
					pixel.B = fallbackColor.B
				}
				pixel.A = 255
				output.SetNRGBA(point.X, point.Y, pixel)
			}
		}
	}
	return output
}

func collectTransparentComponent(source *image.NRGBA, bbox image.Rectangle, startX int, startY int, visited []bool) ([]image.Point, bool) {
	bounds := source.Bounds()
	width := bounds.Dx()
	indexOf := func(x int, y int) int {
		return (y-bounds.Min.Y)*width + (x - bounds.Min.X)
	}
	queue := []image.Point{{X: startX, Y: startY}}
	visited[indexOf(startX, startY)] = true
	points := []image.Point{}
	touchesEdge := false
	for head := 0; head < len(queue); head++ {
		point := queue[head]
		points = append(points, point)
		if point.X == bbox.Min.X || point.X == bbox.Max.X-1 || point.Y == bbox.Min.Y || point.Y == bbox.Max.Y-1 {
			touchesEdge = true
		}
		for _, next := range []image.Point{
			{X: point.X - 1, Y: point.Y},
			{X: point.X + 1, Y: point.Y},
			{X: point.X, Y: point.Y - 1},
			{X: point.X, Y: point.Y + 1},
		} {
			if next.X < bbox.Min.X || next.X >= bbox.Max.X || next.Y < bbox.Min.Y || next.Y >= bbox.Max.Y {
				continue
			}
			index := indexOf(next.X, next.Y)
			if visited[index] {
				continue
			}
			visited[index] = true
			if source.NRGBAAt(next.X, next.Y).A < 10 {
				queue = append(queue, next)
			}
		}
	}
	return points, touchesEdge
}

func averageBoundaryColor(source *image.NRGBA, component []image.Point) (color.NRGBA, bool) {
	bounds := source.Bounds()
	inside := make(map[image.Point]struct{}, len(component))
	for _, point := range component {
		inside[point] = struct{}{}
	}
	var red, green, blue, count int
	for _, point := range component {
		for _, next := range []image.Point{
			{X: point.X - 1, Y: point.Y},
			{X: point.X + 1, Y: point.Y},
			{X: point.X, Y: point.Y - 1},
			{X: point.X, Y: point.Y + 1},
		} {
			if next.X < bounds.Min.X || next.X >= bounds.Max.X || next.Y < bounds.Min.Y || next.Y >= bounds.Max.Y {
				continue
			}
			if _, ok := inside[next]; ok {
				continue
			}
			pixel := source.NRGBAAt(next.X, next.Y)
			if pixel.A < 10 {
				continue
			}
			red += int(pixel.R)
			green += int(pixel.G)
			blue += int(pixel.B)
			count++
		}
	}
	if count == 0 {
		return color.NRGBA{}, false
	}
	return color.NRGBA{R: uint8(red / count), G: uint8(green / count), B: uint8(blue / count), A: 255}, true
}

func mappedSourceColor(source *image.NRGBA, x int, y int, width int, height int) color.NRGBA {
	sourceBounds := source.Bounds()
	sourceX := sourceBounds.Min.X + min(sourceBounds.Dx()-1, max(0, int(math.Round(float64(x)*float64(sourceBounds.Dx()-1)/float64(max(1, width-1))))))
	sourceY := sourceBounds.Min.Y + min(sourceBounds.Dy()-1, max(0, int(math.Round(float64(y)*float64(sourceBounds.Dy()-1)/float64(max(1, height-1))))))
	pixel := source.NRGBAAt(sourceX, sourceY)
	pixel.A = 255
	return pixel
}

func sameAspectRatio(width int, height int, sourceWidth int, sourceHeight int) bool {
	if width <= 0 || height <= 0 || sourceWidth <= 0 || sourceHeight <= 0 {
		return false
	}
	ratio := float64(width) / float64(height)
	sourceRatio := float64(sourceWidth) / float64(sourceHeight)
	return math.Abs(ratio-sourceRatio)/math.Max(sourceRatio, 1e-6) <= 0.08
}

func isInvisibleBlack(pixel color.NRGBA) bool {
	return pixel.A < 10 && int(pixel.R)+int(pixel.G)+int(pixel.B) < 18
}

func transparentCutoutFromOpaqueBackdrop(source *image.NRGBA) (*image.NRGBA, bool) {
	bounds := source.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()
	if width < 24 || height < 24 {
		return nil, false
	}

	corners := sampleCornerNRGBA(source)
	if len(corners) < 16 {
		return nil, false
	}
	background, threshold, ok := detectNeutralBackdrop(corners)
	if !ok {
		return nil, false
	}

	backgroundMask := floodConnectedBackground(source, background, threshold)
	output := image.NewNRGBA(bounds)
	draw.Draw(output, bounds, source, bounds.Min, draw.Src)

	changed := 0
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			index := (y-bounds.Min.Y)*width + (x - bounds.Min.X)
			if !backgroundMask[index] {
				continue
			}
			pixel := source.NRGBAAt(x, y)
			distance := colorDistanceNRGBA(nrgbaToColor(pixel), background)
			alphaRatio := smoothstepFloat(math.Max(3, threshold-6), threshold+6, distance)
			if alphaRatio <= 0.04 {
				pixel.A = 0
			} else {
				pixel.A = uint8(math.Round(float64(pixel.A) * alphaRatio))
			}
			output.SetNRGBA(x, y, pixel)
			changed++
		}
	}

	if changed < max(200, width*height/18) {
		return nil, false
	}
	if bbox, transparentPixels := alphaBounds(output, 10); bbox.Empty() || transparentPixels < width*height/16 {
		return nil, false
	}
	return output, true
}

func alphaBounds(imageData *image.NRGBA, threshold uint8) (image.Rectangle, int) {
	bounds := imageData.Bounds()
	minX := bounds.Max.X
	minY := bounds.Max.Y
	maxX := bounds.Min.X - 1
	maxY := bounds.Min.Y - 1
	transparentPixels := 0
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			alpha := imageData.NRGBAAt(x, y).A
			if alpha < threshold {
				transparentPixels++
				continue
			}
			if x < minX {
				minX = x
			}
			if y < minY {
				minY = y
			}
			if x > maxX {
				maxX = x
			}
			if y > maxY {
				maxY = y
			}
		}
	}
	if maxX < minX || maxY < minY {
		return image.Rectangle{}, transparentPixels
	}
	return image.Rect(minX, minY, maxX+1, maxY+1), transparentPixels
}

func transparentCutoutFromOpaqueFlatBackground(source *image.NRGBA) (*image.NRGBA, bool) {
	bounds := source.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()
	if width < 16 || height < 16 {
		return nil, false
	}

	border := sampleNRGBABorder(source)
	if len(border) == 0 {
		return nil, false
	}
	background := medianColor(border)
	distances := make([]float64, 0, len(border))
	for _, color := range border {
		distances = append(distances, colorDistanceNRGBA(color, background))
	}
	spread90 := percentileFloat(distances, 0.90)
	spread98 := percentileFloat(distances, 0.98)
	if spread90 > 30 || spread98 > 70 {
		return nil, false
	}

	low := math.Max(8, spread90*2.5+4)
	high := math.Max(low+36, spread98+10)
	high = math.Min(95, math.Max(high, 42))
	backgroundMask := floodConnectedBackground(source, background, high)
	output := image.NewNRGBA(bounds)
	draw.Draw(output, bounds, source, bounds.Min, draw.Src)

	changed := 0
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			if !backgroundMask[(y-bounds.Min.Y)*width+(x-bounds.Min.X)] {
				continue
			}
			pixel := source.NRGBAAt(x, y)
			distance := colorDistanceNRGBA(nrgbaToColor(pixel), background)
			alphaRatio := smoothstepFloat(low, high, distance)
			if alphaRatio <= 0.04 {
				pixel.A = 0
			} else {
				pixel.A = uint8(math.Round(float64(pixel.A) * alphaRatio))
			}
			output.SetNRGBA(x, y, pixel)
			changed++
		}
	}

	if changed < max(100, width*height/20) {
		return nil, false
	}
	if bbox, transparentPixels := alphaBounds(output, 10); bbox.Empty() || transparentPixels < width*height/20 {
		return nil, false
	}
	return output, true
}

func sampleCornerNRGBA(imageData *image.NRGBA) []colorNRGBA {
	bounds := imageData.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()
	patchWidth := max(12, width/7)
	patchHeight := max(12, height/7)
	stepX := max(1, patchWidth/18)
	stepY := max(1, patchHeight/18)
	anchors := []image.Point{
		{X: bounds.Min.X, Y: bounds.Min.Y},
		{X: bounds.Max.X - patchWidth, Y: bounds.Min.Y},
		{X: bounds.Min.X, Y: bounds.Max.Y - patchHeight},
		{X: bounds.Max.X - patchWidth, Y: bounds.Max.Y - patchHeight},
	}
	result := make([]colorNRGBA, 0, len(anchors)*(patchWidth/stepX)*(patchHeight/stepY))
	for _, anchor := range anchors {
		startX := max(bounds.Min.X, anchor.X)
		startY := max(bounds.Min.Y, anchor.Y)
		endX := min(bounds.Max.X, startX+patchWidth)
		endY := min(bounds.Max.Y, startY+patchHeight)
		for y := startY; y < endY; y += stepY {
			for x := startX; x < endX; x += stepX {
				result = append(result, nrgbaToColor(imageData.NRGBAAt(x, y)))
			}
		}
	}
	return result
}

func sampleNRGBABorder(imageData *image.NRGBA) []colorNRGBA {
	bounds := imageData.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()
	stepX := max(1, width/48)
	stepY := max(1, height/48)
	result := []colorNRGBA{}
	for x := bounds.Min.X; x < bounds.Max.X; x += stepX {
		result = append(result, nrgbaToColor(imageData.NRGBAAt(x, bounds.Min.Y)))
		result = append(result, nrgbaToColor(imageData.NRGBAAt(x, bounds.Max.Y-1)))
	}
	for y := bounds.Min.Y; y < bounds.Max.Y; y += stepY {
		result = append(result, nrgbaToColor(imageData.NRGBAAt(bounds.Min.X, y)))
		result = append(result, nrgbaToColor(imageData.NRGBAAt(bounds.Max.X-1, y)))
	}
	return result
}

func detectNeutralBackdrop(samples []colorNRGBA) (colorNRGBA, float64, bool) {
	neutral := make([]colorNRGBA, 0, len(samples))
	for _, sample := range samples {
		maxChannel := math.Max(sample.R, math.Max(sample.G, sample.B))
		minChannel := math.Min(sample.R, math.Min(sample.G, sample.B))
		if maxChannel-minChannel > 22 {
			continue
		}
		if (sample.R+sample.G+sample.B)/3 < 170 {
			continue
		}
		neutral = append(neutral, sample)
	}
	if len(neutral) < max(24, len(samples)/5) {
		return colorNRGBA{}, 0, false
	}
	background := medianColor(neutral)
	distances := make([]float64, 0, len(neutral))
	for _, sample := range neutral {
		distances = append(distances, colorDistanceNRGBA(sample, background))
	}
	spread90 := percentileFloat(distances, 0.90)
	spread98 := percentileFloat(distances, 0.98)
	if spread90 > 16 || spread98 > 18 {
		return colorNRGBA{}, 0, false
	}
	return background, math.Min(30, math.Max(24, spread98+10)), true
}

type colorNRGBA struct {
	R float64
	G float64
	B float64
}

func nrgbaToColor(pixel color.NRGBA) colorNRGBA {
	return colorNRGBA{R: float64(pixel.R), G: float64(pixel.G), B: float64(pixel.B)}
}

func medianColor(colors []colorNRGBA) colorNRGBA {
	red := make([]float64, 0, len(colors))
	green := make([]float64, 0, len(colors))
	blue := make([]float64, 0, len(colors))
	for _, color := range colors {
		red = append(red, color.R)
		green = append(green, color.G)
		blue = append(blue, color.B)
	}
	return colorNRGBA{R: medianFloat(red), G: medianFloat(green), B: medianFloat(blue)}
}

func medianFloat(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sort.Float64s(values)
	middle := len(values) / 2
	if len(values)%2 == 1 {
		return values[middle]
	}
	return (values[middle-1] + values[middle]) / 2
}

func colorDistanceNRGBA(color colorNRGBA, background colorNRGBA) float64 {
	dr := color.R - background.R
	dg := color.G - background.G
	db := color.B - background.B
	return math.Sqrt(dr*dr + dg*dg + db*db)
}

func percentileFloat(values []float64, ratio float64) float64 {
	if len(values) == 0 {
		return 0
	}
	ordered := append([]float64{}, values...)
	sort.Float64s(ordered)
	index := int(math.Round(float64(len(ordered)-1) * ratio))
	if index < 0 {
		index = 0
	}
	if index >= len(ordered) {
		index = len(ordered) - 1
	}
	return ordered[index]
}

func floodConnectedBackground(source *image.NRGBA, background colorNRGBA, threshold float64) []bool {
	bounds := source.Bounds()
	width := bounds.Dx()
	height := bounds.Dy()
	mask := make([]bool, width*height)
	queue := make([]image.Point, 0, width*2+height*2)
	add := func(x int, y int) {
		if x < bounds.Min.X || x >= bounds.Max.X || y < bounds.Min.Y || y >= bounds.Max.Y {
			return
		}
		index := (y-bounds.Min.Y)*width + (x - bounds.Min.X)
		if mask[index] {
			return
		}
		color := nrgbaToColor(source.NRGBAAt(x, y))
		if colorDistanceNRGBA(color, background) > threshold {
			return
		}
		mask[index] = true
		queue = append(queue, image.Point{X: x, Y: y})
	}

	for x := bounds.Min.X; x < bounds.Max.X; x++ {
		add(x, bounds.Min.Y)
		add(x, bounds.Max.Y-1)
	}
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		add(bounds.Min.X, y)
		add(bounds.Max.X-1, y)
	}

	for head := 0; head < len(queue); head++ {
		point := queue[head]
		add(point.X-1, point.Y)
		add(point.X+1, point.Y)
		add(point.X, point.Y-1)
		add(point.X, point.Y+1)
	}
	return mask
}

func smoothstepFloat(edge0 float64, edge1 float64, value float64) float64 {
	if value <= edge0 {
		return 0
	}
	if value >= edge1 {
		return 1
	}
	ratio := (value - edge0) / math.Max(edge1-edge0, 1e-6)
	return ratio * ratio * (3 - 2*ratio)
}

func safeRemoveBackgroundFilename(filename string, contentType string) string {
	cleaned := strings.TrimSpace(filepath.Base(filename))
	if cleaned != "" && cleaned != "." && cleaned != string(filepath.Separator) {
		return cleaned
	}
	return "remove-bg-input" + imageExtByMime(contentType, "")
}

func runRemoveBackgroundProcess(ctx context.Context, inputPath string, outputPath string, metaPath string, focusBox *layerImageFocusBox) error {
	if err := removeBackgroundWithWorker(ctx, inputPath, outputPath, metaPath, focusBox); err != nil {
		log.Printf("remove background worker failed, fallback to one-shot command: %v", err)
		if fallbackErr := runRemoveBackgroundCommand(ctx, inputPath, outputPath, metaPath, focusBox); fallbackErr != nil {
			return fallbackErr
		}
	}
	return nil
}

func readRemoveBackgroundArtifacts(outputPath string, metaPath string) ([]byte, layerImageMeta, error) {
	result, err := os.ReadFile(outputPath)
	if err != nil {
		return nil, layerImageMeta{}, err
	}
	if len(result) == 0 {
		return nil, layerImageMeta{}, errors.New("去背景结果为空")
	}
	metaBytes, err := os.ReadFile(metaPath)
	if err != nil {
		return nil, layerImageMeta{}, err
	}
	meta := layerImageMeta{}
	if err := json.Unmarshal(metaBytes, &meta); err != nil {
		return nil, layerImageMeta{}, err
	}
	if meta.OriginalWidth <= 0 || meta.OriginalHeight <= 0 || meta.ProductWidth <= 0 || meta.ProductHeight <= 0 {
		return nil, layerImageMeta{}, safeMessageError{message: "去背景结果无效"}
	}
	return result, meta, nil
}

func removeBackgroundWithWorker(ctx context.Context, inputPath string, outputPath string, metaPath string, focusBox *layerImageFocusBox) error {
	worker, err := ensureRemoveBackgroundWorker(ctx)
	if err != nil {
		return err
	}
	return worker.process(ctx, inputPath, outputPath, metaPath, focusBox)
}

func ensureRemoveBackgroundWorker(ctx context.Context) (*removeBackgroundWorker, error) {
	return removeBackgroundWorkerInst.ensure(ctx)
}

func (worker *removeBackgroundWorker) ensure(ctx context.Context) (*removeBackgroundWorker, error) {
	worker.mu.Lock()
	defer worker.mu.Unlock()
	if worker.cmd != nil && worker.stdin != nil && worker.stdout != nil {
		return worker, nil
	}
	if err := worker.startLocked(ctx); err != nil {
		return nil, err
	}
	return worker, nil
}

func (worker *removeBackgroundWorker) startLocked(ctx context.Context) error {
	scriptPath, err := removeBackgroundWorkerScriptPath()
	if err != nil {
		return err
	}

	stderr := &lockedBuffer{}
	args := []string{"-u", scriptPath, "--model", strings.TrimSpace(config.Cfg.RemoveBGModel)}
	cmd := exec.Command(strings.TrimSpace(config.Cfg.RemoveBGPython), args...)
	cmd.Dir = projectRoot()
	cmd.Env = append(
		os.Environ(),
		"PYTHONUNBUFFERED=1",
		"PYTHONPATH="+joinedPythonPath(resolveWorkspacePath(config.Cfg.RemoveBGPythonPath), os.Getenv("PYTHONPATH")),
	)
	cmd.Stderr = stderr

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return err
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return err
	}

	stdout := bufio.NewReader(stdoutPipe)
	response, err := readRemoveBackgroundWorkerResponse(ctx, stdout)
	if err != nil {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		go func() { _ = cmd.Wait() }()
		return normalizeRemoveBackgroundFailure(err, []byte(stderr.String()))
	}
	if !response.Ready {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		go func() { _ = cmd.Wait() }()
		return normalizeRemoveBackgroundFailure(errors.New("去背景 worker 未就绪"), []byte(response.Error+"\n"+stderr.String()))
	}

	worker.cmd = cmd
	worker.stdin = stdin
	worker.stdout = stdout
	worker.stderr = stderr

	go worker.watch(cmd)

	return nil
}

func (worker *removeBackgroundWorker) watch(command *exec.Cmd) {
	if err := command.Wait(); err != nil {
		log.Printf("remove background worker exited: %v", err)
	}
	worker.mu.Lock()
	defer worker.mu.Unlock()
	if worker.cmd == command {
		worker.stdin = nil
		worker.stdout = nil
		worker.cmd = nil
	}
}

func (worker *removeBackgroundWorker) process(ctx context.Context, inputPath string, outputPath string, metaPath string, focusBox *layerImageFocusBox) error {
	worker.mu.Lock()
	defer worker.mu.Unlock()

	if worker.cmd == nil || worker.stdin == nil || worker.stdout == nil {
		return errors.New("去背景 worker 未启动")
	}

	payload, err := json.Marshal(removeBackgroundWorkerRequest{
		Input:      inputPath,
		Output:     outputPath,
		MetaOutput: metaPath,
		FocusBox:   focusBox,
	})
	if err != nil {
		return err
	}
	if _, err := worker.stdin.Write(append(payload, '\n')); err != nil {
		worker.closeLocked()
		return normalizeRemoveBackgroundFailure(err, []byte(worker.stderrStringLocked()))
	}

	response, err := readRemoveBackgroundWorkerResponse(ctx, worker.stdout)
	if err != nil {
		worker.closeLocked()
		return normalizeRemoveBackgroundFailure(err, []byte(worker.stderrStringLocked()))
	}
	if response.OK {
		return nil
	}

	errOutput := response.Error
	if stderr := worker.stderrStringLocked(); strings.TrimSpace(stderr) != "" {
		errOutput = strings.TrimSpace(strings.Join([]string{errOutput, stderr}, "\n"))
	}
	if errOutput == "" {
		errOutput = "去背景 worker 返回异常"
	}
	return normalizeRemoveBackgroundFailure(errors.New(errOutput), []byte(errOutput))
}

func (worker *removeBackgroundWorker) stderrStringLocked() string {
	if worker.stderr == nil {
		return ""
	}
	return worker.stderr.String()
}

func (worker *removeBackgroundWorker) closeLocked() {
	if worker.stdin != nil {
		_ = worker.stdin.Close()
	}
	if worker.cmd != nil && worker.cmd.Process != nil {
		_ = worker.cmd.Process.Kill()
	}
	worker.stdin = nil
	worker.stdout = nil
	worker.cmd = nil
}

func readRemoveBackgroundWorkerResponse(ctx context.Context, reader *bufio.Reader) (removeBackgroundWorkerResponse, error) {
	type responseResult struct {
		line []byte
		err  error
	}

	resultCh := make(chan responseResult, 1)
	go func() {
		line, err := reader.ReadBytes('\n')
		resultCh <- responseResult{line: line, err: err}
	}()

	select {
	case <-ctx.Done():
		return removeBackgroundWorkerResponse{}, ctx.Err()
	case result := <-resultCh:
		if result.err != nil {
			return removeBackgroundWorkerResponse{}, result.err
		}
		line := bytes.TrimSpace(result.line)
		response := removeBackgroundWorkerResponse{}
		if err := json.Unmarshal(line, &response); err != nil {
			return response, fmt.Errorf("去背景 worker 响应解析失败: %w", err)
		}
		return response, nil
	}
}

func runRemoveBackgroundCommand(ctx context.Context, inputPath string, outputPath string, metaPath string, focusBox *layerImageFocusBox) error {
	command, err := removeBackgroundCommand(ctx, inputPath, outputPath, metaPath, focusBox)
	if err != nil {
		return err
	}
	output, err := command.CombinedOutput()
	if err != nil {
		return normalizeRemoveBackgroundFailure(err, output)
	}
	return nil
}

func removeBackgroundCommand(ctx context.Context, inputPath string, outputPath string, metaPath string, focusBox *layerImageFocusBox) (*exec.Cmd, error) {
	scriptPath, err := removeBackgroundScriptPath()
	if err != nil {
		return nil, err
	}
	args := []string{scriptPath, "--model", strings.TrimSpace(config.Cfg.RemoveBGModel), "--input", inputPath, "--output", outputPath, "--meta-output", metaPath}
	if focusBox != nil {
		args = append(
			args,
			"--focus-left", fmt.Sprintf("%d", focusBox.Left),
			"--focus-top", fmt.Sprintf("%d", focusBox.Top),
			"--focus-right", fmt.Sprintf("%d", focusBox.Right),
			"--focus-bottom", fmt.Sprintf("%d", focusBox.Bottom),
		)
	}
	cmd := exec.CommandContext(ctx, strings.TrimSpace(config.Cfg.RemoveBGPython), args...)
	cmd.Dir = projectRoot()
	cmd.Env = append(os.Environ(), "PYTHONPATH="+joinedPythonPath(resolveWorkspacePath(config.Cfg.RemoveBGPythonPath), os.Getenv("PYTHONPATH")))
	return cmd, nil
}

func removeBackgroundScriptPath() (string, error) {
	path := resolveWorkspacePath("tools/remove_background.py")
	if _, err := os.Stat(path); err != nil {
		return "", fmt.Errorf("去背景脚本不存在: %w", err)
	}
	return path, nil
}

func removeBackgroundWorkerScriptPath() (string, error) {
	path := resolveWorkspacePath("tools/remove_background_worker.py")
	if _, err := os.Stat(path); err != nil {
		return "", fmt.Errorf("去背景 worker 脚本不存在: %w", err)
	}
	return path, nil
}

func resolveWorkspacePath(path string) string {
	if filepath.IsAbs(path) {
		return path
	}
	return filepath.Join(projectRoot(), filepath.FromSlash(path))
}

func projectRoot() string {
	candidates := []string{}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates, cwd)
	}
	if executable, err := os.Executable(); err == nil {
		candidates = append(candidates, filepath.Dir(executable))
	}
	for _, candidate := range candidates {
		current := candidate
		for {
			if _, err := os.Stat(filepath.Join(current, "go.mod")); err == nil {
				return current
			}
			parent := filepath.Dir(current)
			if parent == current {
				break
			}
			current = parent
		}
	}
	return "."
}

func joinedPythonPath(primary string, current string) string {
	values := []string{}
	if strings.TrimSpace(primary) != "" {
		values = append(values, primary)
	}
	if strings.TrimSpace(current) != "" {
		values = append(values, current)
	}
	return strings.Join(values, string(os.PathListSeparator))
}

func imageExtByMime(contentType string, filename string) string {
	switch strings.ToLower(strings.TrimSpace(contentType)) {
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "image/bmp":
		return ".bmp"
	}
	ext := strings.ToLower(strings.TrimSpace(filepath.Ext(filename)))
	if ext == ".jpg" || ext == ".jpeg" || ext == ".png" || ext == ".webp" || ext == ".bmp" {
		return ext
	}
	return ".png"
}

func normalizeRemoveBackgroundFailure(commandErr error, output []byte) error {
	message := strings.TrimSpace(string(output))
	switch {
	case strings.Contains(message, "No module named 'rembg'"),
		strings.Contains(message, "No module named rembg"),
		strings.Contains(message, "ModuleNotFoundError"):
		return safeMessageError{message: "去背景依赖未安装，请先执行 `pip install -r tools/remove_background_requirements.txt -t .local/pydeps`"}
	case strings.Contains(message, "HTTPError"),
		strings.Contains(message, "Gateway Time-out"),
		strings.Contains(message, "Read timed out"):
		return safeMessageError{message: "去背景模型首次下载失败，请重试一次"}
	}
	if message == "" {
		message = commandErr.Error()
	}
	if len(message) > 400 {
		message = message[:400] + "..."
	}
	return safeMessageError{message: "去背景失败：" + message}
}

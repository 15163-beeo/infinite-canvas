package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"image/color"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"

	openapi "github.com/alibabacloud-go/darabonba-openapi/v2/client"
	ocr "github.com/alibabacloud-go/ocr-api-20210707/v3/client"
	util "github.com/alibabacloud-go/tea-utils/v2/service"
	"github.com/alibabacloud-go/tea/tea"
	"github.com/basketikun/infinite-canvas/config"
)

var (
	aliyunOCRClientMu sync.Mutex
	aliyunOCRClient   *ocr.Client
	aliyunOCRClientID string
)

func aliyunOCRConfigured() bool {
	if !config.Cfg.AliyunOCREnabled {
		return false
	}
	return strings.TrimSpace(config.Cfg.AliyunImageSegAccessKeyID) != "" &&
		strings.TrimSpace(config.Cfg.AliyunImageSegAccessKeySecret) != ""
}

func detectLayerImageTextLayersWithAliyunOCR(ctx context.Context, data []byte, meta layerImageMeta) ([]LayerImageTextLayer, error) {
	if !aliyunOCRConfigured() {
		return nil, errors.New("阿里云 OCR 未配置")
	}
	client, err := getAliyunOCRClient()
	if err != nil {
		return nil, err
	}

	timeoutSeconds := max(5, config.Cfg.AliyunOCRTimeout)
	response, err := client.RecognizeAllTextWithOptions(&ocr.RecognizeAllTextRequest{
		Body:             bytes.NewReader(data),
		Type:             tea.String(firstNonEmpty(strings.TrimSpace(config.Cfg.AliyunOCRType), "Advanced")),
		OutputCoordinate: tea.String("rectangle"),
		OutputOricoord:   tea.Bool(true),
		AdvancedConfig: &ocr.RecognizeAllTextRequestAdvancedConfig{
			OutputCharInfo:  tea.Bool(false),
			OutputParagraph: tea.Bool(false),
			OutputRow:       tea.Bool(false),
			OutputTable:     tea.Bool(false),
		},
	}, &util.RuntimeOptions{
		ConnectTimeout: tea.Int(10 * 1000),
		ReadTimeout:    tea.Int(timeoutSeconds * 1000),
		Autoretry:      tea.Bool(false),
	})
	if err != nil {
		return nil, safeMessageError{message: "阿里云 OCR 识别失败：" + err.Error()}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if response == nil || response.Body == nil {
		return nil, errors.New("阿里云 OCR 返回为空")
	}
	if code := strings.TrimSpace(tea.StringValue(response.Body.Code)); code != "" && code != "200" && !strings.EqualFold(code, "Success") {
		message := strings.TrimSpace(tea.StringValue(response.Body.Message))
		if message == "" {
			message = code
		}
		return nil, safeMessageError{message: "阿里云 OCR 识别失败：" + message}
	}
	return layerImageTextLayersFromAliyunOCR(response.Body.Data, data, meta), nil
}

func getAliyunOCRClient() (*ocr.Client, error) {
	accessKeyID := strings.TrimSpace(config.Cfg.AliyunImageSegAccessKeyID)
	accessKeySecret := strings.TrimSpace(config.Cfg.AliyunImageSegAccessKeySecret)
	endpoint := strings.TrimSpace(config.Cfg.AliyunOCREndpoint)
	if endpoint == "" {
		endpoint = "ocr-api.cn-hangzhou.aliyuncs.com"
	}
	if accessKeyID == "" || accessKeySecret == "" {
		return nil, errors.New("阿里云 OCR 缺少 AccessKey")
	}

	clientID := strings.Join([]string{accessKeyID, endpoint}, "\x00")
	aliyunOCRClientMu.Lock()
	defer aliyunOCRClientMu.Unlock()
	if aliyunOCRClient != nil && aliyunOCRClientID == clientID {
		return aliyunOCRClient, nil
	}
	client, err := ocr.NewClient(&openapi.Config{
		AccessKeyId:     tea.String(accessKeyID),
		AccessKeySecret: tea.String(accessKeySecret),
		Endpoint:        tea.String(endpoint),
		Protocol:        tea.String("HTTPS"),
	})
	if err != nil {
		return nil, fmt.Errorf("创建阿里云 OCR 客户端失败：%w", err)
	}
	aliyunOCRClient = client
	aliyunOCRClientID = clientID
	return client, nil
}

func layerImageTextLayersFromAliyunOCR(data *ocr.RecognizeAllTextResponseBodyData, source []byte, meta layerImageMeta) []LayerImageTextLayer {
	if data == nil {
		return nil
	}
	sourceImage, _, _ := decodeNRGBAImage(source)
	result := []LayerImageTextLayer{}
	for _, subImage := range data.SubImages {
		if subImage == nil || subImage.BlockInfo == nil {
			continue
		}
		for _, block := range subImage.BlockInfo.BlockDetails {
			layer, ok := layerImageTextLayerFromAliyunBlock(block, sourceImage, meta)
			if !ok {
				continue
			}
			result = append(result, layer)
			if len(result) >= 60 {
				return result
			}
		}
	}
	sort.SliceStable(result, func(i, j int) bool {
		if math.Abs(result[i].Position.Y-result[j].Position.Y) > 8 {
			return result[i].Position.Y < result[j].Position.Y
		}
		return result[i].Position.X < result[j].Position.X
	})
	return result
}

func layerImageTextLayerFromAliyunBlock(block *ocr.RecognizeAllTextResponseBodyDataSubImagesBlockInfoBlockDetails, source *image.NRGBA, meta layerImageMeta) (LayerImageTextLayer, bool) {
	if block == nil {
		return LayerImageTextLayer{}, false
	}
	text := strings.TrimSpace(tea.StringValue(block.BlockContent))
	if text == "" || len([]rune(text)) > 120 {
		return LayerImageTextLayer{}, false
	}
	confidence := int(tea.Int32Value(block.BlockConfidence))
	minConfidence := max(1, config.Cfg.AliyunOCRMinConfidence)
	if confidence > 0 && confidence < minConfidence {
		return LayerImageTextLayer{}, false
	}

	x, y, width, height, ok := aliyunOCRBlockBounds(block, meta)
	if !ok {
		return LayerImageTextLayer{}, false
	}
	if shouldSkipProductTextLayer(x, y, width, height, meta) {
		return LayerImageTextLayer{}, false
	}
	fontSize := math.Max(8, math.Min(height*0.78, height))
	fontWeight := "normal"
	if height >= 80 {
		fontWeight = "900"
	} else if height >= 28 {
		fontWeight = "700"
	}
	colorHex := "#111111"
	strokeColor := ""
	strokeWidth := 0.0
	if source != nil {
		colorHex = estimateTextColorHex(source, x, y, width, height)
		strokeColor, strokeWidth = estimateTextStroke(source, x, y, width, height, fontSize, colorHex)
	}
	return LayerImageTextLayer{
		Text: text,
		Position: LayerImagePosition{
			X: x,
			Y: y,
		},
		Size: LayerImageSize{
			Width:  width,
			Height: height,
		},
		FontFamily:  "sans-serif",
		FontWeight:  fontWeight,
		FontStyle:   "normal",
		FontSize:    fontSize,
		Color:       colorHex,
		StrokeColor: strokeColor,
		StrokeWidth: strokeWidth,
		Rotation:    float64(tea.Int32Value(block.BlockAngle)),
		Opacity:     1,
	}, true
}

func aliyunOCRBlockBounds(block *ocr.RecognizeAllTextResponseBodyDataSubImagesBlockInfoBlockDetails, meta layerImageMeta) (float64, float64, float64, float64, bool) {
	if len(block.BlockPoints) > 0 {
		minX := float64(max(1, meta.OriginalWidth))
		minY := float64(max(1, meta.OriginalHeight))
		maxX := 0.0
		maxY := 0.0
		for _, point := range block.BlockPoints {
			if point == nil {
				continue
			}
			x := float64(tea.Int32Value(point.X))
			y := float64(tea.Int32Value(point.Y))
			minX = math.Min(minX, x)
			minY = math.Min(minY, y)
			maxX = math.Max(maxX, x)
			maxY = math.Max(maxY, y)
		}
		width := maxX - minX
		height := maxY - minY
		if width >= 2 && height >= 2 {
			return clampLayerRect(minX, minY, width, height, meta)
		}
	}
	if block.BlockRect != nil {
		width := float64(tea.Int32Value(block.BlockRect.Width))
		height := float64(tea.Int32Value(block.BlockRect.Height))
		x := float64(tea.Int32Value(block.BlockRect.CenterX)) - width/2
		y := float64(tea.Int32Value(block.BlockRect.CenterY)) - height/2
		if width >= 2 && height >= 2 {
			return clampLayerRect(x, y, width, height, meta)
		}
	}
	return 0, 0, 0, 0, false
}

func clampLayerRect(x float64, y float64, width float64, height float64, meta layerImageMeta) (float64, float64, float64, float64, bool) {
	maxWidth := float64(max(1, meta.OriginalWidth))
	maxHeight := float64(max(1, meta.OriginalHeight))
	x = clampFloat(x, 0, maxWidth-1)
	y = clampFloat(y, 0, maxHeight-1)
	width = clampFloat(width, 1, maxWidth-x)
	height = clampFloat(height, 1, maxHeight-y)
	if width < 3 || height < 3 {
		return 0, 0, 0, 0, false
	}
	return x, y, width, height, true
}

func shouldSkipProductTextLayer(x float64, y float64, width float64, height float64, meta layerImageMeta) bool {
	if meta.ProductWidth <= 0 || meta.ProductHeight <= 0 {
		return false
	}
	productRect := rectFloat{
		x: float64(meta.ProductOffsetX),
		y: float64(meta.ProductOffsetY),
		w: float64(meta.ProductWidth),
		h: float64(meta.ProductHeight),
	}
	textRect := rectFloat{x: x, y: y, w: width, h: height}
	centerInsideProduct := textRect.x+textRect.w/2 >= productRect.x &&
		textRect.x+textRect.w/2 <= productRect.x+productRect.w &&
		textRect.y+textRect.h/2 >= productRect.y &&
		textRect.y+textRect.h/2 <= productRect.y+productRect.h
	overlap := rectOverlapArea(textRect, productRect)
	textArea := math.Max(1, textRect.w*textRect.h)
	return centerInsideProduct && overlap/textArea > 0.35
}

type rectFloat struct {
	x float64
	y float64
	w float64
	h float64
}

func rectOverlapArea(a rectFloat, b rectFloat) float64 {
	left := math.Max(a.x, b.x)
	top := math.Max(a.y, b.y)
	right := math.Min(a.x+a.w, b.x+b.w)
	bottom := math.Min(a.y+a.h, b.y+b.h)
	if right <= left || bottom <= top {
		return 0
	}
	return (right - left) * (bottom - top)
}

func estimateTextColorHex(source *image.NRGBA, x float64, y float64, width float64, height float64) string {
	bounds := source.Bounds()
	left := max(bounds.Min.X, int(math.Floor(x)))
	top := max(bounds.Min.Y, int(math.Floor(y)))
	right := min(bounds.Max.X, int(math.Ceil(x+width)))
	bottom := min(bounds.Max.Y, int(math.Ceil(y+height)))
	if right <= left || bottom <= top {
		return "#111111"
	}
	step := max(1, min(right-left, bottom-top)/28)
	samples := []color.NRGBA{}
	for yy := top; yy < bottom; yy += step {
		for xx := left; xx < right; xx += step {
			pixel := source.NRGBAAt(xx, yy)
			if pixel.A >= 32 {
				samples = append(samples, pixel)
			}
		}
	}
	if len(samples) == 0 {
		return "#111111"
	}
	background := estimateTextBackgroundColor(source, left, top, right, bottom, step)
	if foreground, ok := estimateForegroundTextColor(samples, background); ok {
		return foreground
	}
	return estimateTextColorByLuminance(samples)
}

func estimateTextStroke(source *image.NRGBA, x float64, y float64, width float64, height float64, fontSize float64, foregroundHex string) (string, float64) {
	bounds := source.Bounds()
	left := max(bounds.Min.X, int(math.Floor(x)))
	top := max(bounds.Min.Y, int(math.Floor(y)))
	right := min(bounds.Max.X, int(math.Ceil(x+width)))
	bottom := min(bounds.Max.Y, int(math.Ceil(y+height)))
	if right <= left || bottom <= top {
		return "", 0
	}
	step := max(1, min(right-left, bottom-top)/28)
	background := estimateTextBackgroundColor(source, left, top, right, bottom, step)
	foreground, ok := parseHexColorNRGBA(foregroundHex)
	if !ok {
		return "", 0
	}
	foregroundLum := luminance(foreground)
	backgroundLum := 0.2126*background.R + 0.7152*background.G + 0.0722*background.B
	if foregroundLum < 130 && backgroundLum > 155 {
		return "#ffffff", clampFloat(fontSize*0.055, 1, 8)
	}
	return "", 0
}

func estimateTextBackgroundColor(source *image.NRGBA, left int, top int, right int, bottom int, step int) colorNRGBA {
	borderSamples := []colorNRGBA{}
	borderThickness := max(1, min(right-left, bottom-top)/8)
	for yy := top; yy < bottom; yy += step {
		for xx := left; xx < right; xx += step {
			if yy > top+borderThickness && yy < bottom-borderThickness && xx > left+borderThickness && xx < right-borderThickness {
				continue
			}
			pixel := source.NRGBAAt(xx, yy)
			if pixel.A >= 32 {
				borderSamples = append(borderSamples, nrgbaToColor(pixel))
			}
		}
	}
	if len(borderSamples) == 0 {
		return colorNRGBA{R: 255, G: 255, B: 255}
	}
	return medianColor(borderSamples)
}

func estimateForegroundTextColor(samples []color.NRGBA, background colorNRGBA) (string, bool) {
	type bucket struct {
		red      int
		green    int
		blue     int
		count    int
		contrast float64
	}
	buckets := map[int]*bucket{}
	for _, pixel := range samples {
		colorValue := nrgbaToColor(pixel)
		contrast := colorDistanceNRGBA(colorValue, background)
		if contrast < 28 {
			continue
		}
		key := int(pixel.R/24)<<16 | int(pixel.G/24)<<8 | int(pixel.B/24)
		item := buckets[key]
		if item == nil {
			item = &bucket{}
			buckets[key] = item
		}
		item.red += int(pixel.R)
		item.green += int(pixel.G)
		item.blue += int(pixel.B)
		item.count++
		item.contrast += contrast
	}
	if len(buckets) == 0 {
		return "", false
	}
	var best *bucket
	bestScore := -1.0
	for _, item := range buckets {
		avgContrast := item.contrast / float64(max(1, item.count))
		score := math.Sqrt(float64(item.count)) * avgContrast
		if score > bestScore {
			bestScore = score
			best = item
		}
	}
	if best == nil || best.count == 0 {
		return "", false
	}
	red := best.red / best.count
	green := best.green / best.count
	blue := best.blue / best.count
	return fmt.Sprintf("#%02x%02x%02x", red, green, blue), true
}

func estimateTextColorByLuminance(samples []color.NRGBA) string {
	sort.Slice(samples, func(i, j int) bool {
		return luminance(samples[i]) < luminance(samples[j])
	})
	median := luminance(samples[len(samples)/2])
	var chosen []color.NRGBA
	if median > 128 {
		chosen = samples[:max(1, len(samples)/4)]
	} else {
		chosen = samples[len(samples)-max(1, len(samples)/4):]
	}
	var red, green, blue int
	for _, pixel := range chosen {
		red += int(pixel.R)
		green += int(pixel.G)
		blue += int(pixel.B)
	}
	count := max(1, len(chosen))
	return fmt.Sprintf("#%02x%02x%02x", red/count, green/count, blue/count)
}

func luminance(pixel color.NRGBA) float64 {
	return 0.2126*float64(pixel.R) + 0.7152*float64(pixel.G) + 0.0722*float64(pixel.B)
}

func parseHexColorNRGBA(value string) (color.NRGBA, bool) {
	cleaned := strings.TrimPrefix(strings.TrimSpace(value), "#")
	if len(cleaned) != 6 {
		return color.NRGBA{}, false
	}
	red, err := strconv.ParseUint(cleaned[0:2], 16, 8)
	if err != nil {
		return color.NRGBA{}, false
	}
	green, err := strconv.ParseUint(cleaned[2:4], 16, 8)
	if err != nil {
		return color.NRGBA{}, false
	}
	blue, err := strconv.ParseUint(cleaned[4:6], 16, 8)
	if err != nil {
		return color.NRGBA{}, false
	}
	return color.NRGBA{R: uint8(red), G: uint8(green), B: uint8(blue), A: 255}, true
}

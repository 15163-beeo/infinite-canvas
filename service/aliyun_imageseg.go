package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"io"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	openapi "github.com/alibabacloud-go/darabonba-openapi/v2/client"
	imageseg "github.com/alibabacloud-go/imageseg-20191230/v2/client"
	util "github.com/alibabacloud-go/tea-utils/v2/service"
	"github.com/alibabacloud-go/tea/tea"
	"github.com/basketikun/infinite-canvas/config"
)

const aliyunImageSegCacheLimit = 128

var (
	aliyunImageSegClientMu sync.Mutex
	aliyunImageSegClient   *imageseg.Client
	aliyunImageSegClientID string

	aliyunImageSegCache = struct {
		sync.Mutex
		order  []string
		values map[string]*RemoveBackgroundResult
	}{
		values: make(map[string]*RemoveBackgroundResult),
	}
)

func aliyunImageSegConfigured() bool {
	if !config.Cfg.AliyunImageSegEnabled {
		return false
	}
	return strings.TrimSpace(config.Cfg.AliyunImageSegAccessKeyID) != "" &&
		strings.TrimSpace(config.Cfg.AliyunImageSegAccessKeySecret) != ""
}

func removeBackgroundWithAliyunImageSeg(ctx context.Context, filename string, contentType string, data []byte) (*RemoveBackgroundResult, error) {
	if !aliyunImageSegConfigured() {
		return nil, errors.New("阿里云商品分割未配置")
	}

	cacheKey := aliyunImageSegCacheKey(data)
	if cached := getAliyunImageSegCache(cacheKey); cached != nil {
		return cached, nil
	}

	client, err := getAliyunImageSegClient()
	if err != nil {
		return nil, err
	}

	timeoutSeconds := max(5, config.Cfg.AliyunImageSegTimeout)
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSeconds)*time.Second)
	defer cancel()

	runtime := &util.RuntimeOptions{
		ConnectTimeout: tea.Int(10 * 1000),
		ReadTimeout:    tea.Int(timeoutSeconds * 1000),
		Autoretry:      tea.Bool(false),
	}
	response, err := client.SegmentCommodityAdvance(&imageseg.SegmentCommodityAdvanceRequest{
		ImageURLObject: bytes.NewReader(data),
		ReturnForm:     tea.String("crop"),
	}, runtime)
	if err != nil {
		return nil, safeMessageError{message: "阿里云商品分割失败：" + err.Error()}
	}
	if err := callCtx.Err(); err != nil {
		return nil, err
	}

	resultURL := ""
	if response != nil && response.Body != nil && response.Body.Data != nil {
		resultURL = strings.TrimSpace(tea.StringValue(response.Body.Data.ImageURL))
	}
	if resultURL == "" {
		return nil, safeMessageError{message: "阿里云商品分割没有返回图片"}
	}

	resultBytes, err := downloadAliyunImageSegResult(callCtx, resultURL)
	if err != nil {
		return nil, err
	}
	result, err := normalizeTransparentCutout(resultBytes, data)
	if err != nil {
		return nil, safeMessageError{message: "阿里云商品分割结果无效：" + err.Error()}
	}
	result = alignAliyunImageSegResultToSource(result, data)
	setAliyunImageSegCache(cacheKey, result)
	return cloneRemoveBackgroundResult(result), nil
}

func removeBackgroundWithFocusedAliyunImageSeg(ctx context.Context, filename string, data []byte, focusBox *layerImageFocusBox) (*RemoveBackgroundResult, error) {
	if focusBox == nil {
		return nil, errors.New("商品主体框为空")
	}
	source, sourceWidth, sourceHeight := decodeNRGBAImage(data)
	if source == nil || sourceWidth <= 0 || sourceHeight <= 0 {
		return nil, errors.New("原图解析失败")
	}
	sourceBounds := source.Bounds()
	rect := image.Rect(focusBox.Left, focusBox.Top, focusBox.Right, focusBox.Bottom).Intersect(sourceBounds)
	if rect.Empty() {
		return nil, errors.New("商品主体框无效")
	}
	padding := max(8, min(sourceWidth, sourceHeight)/70)
	rect = expandRect(rect, padding, sourceBounds)
	if rect.Dx() < 16 || rect.Dy() < 16 {
		return nil, errors.New("商品主体框过小")
	}

	crop := image.NewNRGBA(image.Rect(0, 0, rect.Dx(), rect.Dy()))
	draw.Draw(crop, crop.Bounds(), source, rect.Min, draw.Src)
	cropData, err := encodeNRGBAPNG(crop)
	if err != nil {
		return nil, err
	}
	result, err := removeBackgroundWithAliyunImageSeg(ctx, filename, "image/png", cropData)
	if err != nil {
		return nil, err
	}
	result.OriginalWidth = sourceWidth
	result.OriginalHeight = sourceHeight
	result.ProductOffsetX += rect.Min.X
	result.ProductOffsetY += rect.Min.Y
	result.ProductOffsetX = max(0, min(sourceWidth-1, result.ProductOffsetX))
	result.ProductOffsetY = max(0, min(sourceHeight-1, result.ProductOffsetY))
	result.ProductWidth = max(1, min(sourceWidth-result.ProductOffsetX, result.ProductWidth))
	result.ProductHeight = max(1, min(sourceHeight-result.ProductOffsetY, result.ProductHeight))
	return result, nil
}

func alignAliyunImageSegResultToSource(result *RemoveBackgroundResult, sourceData []byte) *RemoveBackgroundResult {
	if result == nil || len(result.Image) == 0 {
		return result
	}
	product, productWidth, productHeight := decodeNRGBAImage(result.Image)
	source, sourceWidth, sourceHeight := decodeNRGBAImage(sourceData)
	if product == nil || source == nil || productWidth <= 0 || productHeight <= 0 || sourceWidth <= 0 || sourceHeight <= 0 {
		return result
	}
	if productWidth > sourceWidth || productHeight > sourceHeight {
		return result
	}
	if absInt(result.ProductWidth-productWidth) <= 2 && absInt(result.ProductHeight-productHeight) <= 2 &&
		result.ProductOffsetX >= 0 && result.ProductOffsetY >= 0 &&
		result.ProductOffsetX+result.ProductWidth <= sourceWidth &&
		result.ProductOffsetY+result.ProductHeight <= sourceHeight {
		return result
	}
	offset, ok := locateCutoutInSource(product, source)
	if !ok {
		return result
	}
	aligned := cloneRemoveBackgroundResult(result)
	aligned.OriginalWidth = sourceWidth
	aligned.OriginalHeight = sourceHeight
	aligned.ProductOffsetX = offset.X
	aligned.ProductOffsetY = offset.Y
	aligned.ProductWidth = productWidth
	aligned.ProductHeight = productHeight
	return aligned
}

type cutoutMatchSample struct {
	x     int
	y     int
	color color.NRGBA
}

func locateCutoutInSource(product *image.NRGBA, source *image.NRGBA) (image.Point, bool) {
	productBounds := product.Bounds()
	sourceBounds := source.Bounds()
	productWidth := productBounds.Dx()
	productHeight := productBounds.Dy()
	sourceWidth := sourceBounds.Dx()
	sourceHeight := sourceBounds.Dy()
	if productWidth <= 0 || productHeight <= 0 || productWidth > sourceWidth || productHeight > sourceHeight {
		return image.Point{}, false
	}
	samples := collectCutoutMatchSamples(product, 720, true)
	if len(samples) < 24 {
		samples = collectCutoutMatchSamples(product, 720, false)
	}
	if len(samples) < 24 {
		return image.Point{}, false
	}

	maxX := sourceWidth - productWidth
	maxY := sourceHeight - productHeight
	coarseStep := max(1, min(10, min(sourceWidth, sourceHeight)/260))
	bestPoint := image.Point{}
	bestScore := math.Inf(1)
	for y := 0; y <= maxY; y += coarseStep {
		for x := 0; x <= maxX; x += coarseStep {
			score := cutoutMatchScore(source, samples, x, y, bestScore)
			if score < bestScore {
				bestScore = score
				bestPoint = image.Point{X: x, Y: y}
			}
		}
	}
	if maxX%coarseStep != 0 {
		x := maxX
		for y := 0; y <= maxY; y += coarseStep {
			score := cutoutMatchScore(source, samples, x, y, bestScore)
			if score < bestScore {
				bestScore = score
				bestPoint = image.Point{X: x, Y: y}
			}
		}
	}
	if maxY%coarseStep != 0 {
		y := maxY
		for x := 0; x <= maxX; x += coarseStep {
			score := cutoutMatchScore(source, samples, x, y, bestScore)
			if score < bestScore {
				bestScore = score
				bestPoint = image.Point{X: x, Y: y}
			}
		}
	}

	fineRadius := max(2, coarseStep*2)
	for y := max(0, bestPoint.Y-fineRadius); y <= min(maxY, bestPoint.Y+fineRadius); y++ {
		for x := max(0, bestPoint.X-fineRadius); x <= min(maxX, bestPoint.X+fineRadius); x++ {
			score := cutoutMatchScore(source, samples, x, y, bestScore)
			if score < bestScore {
				bestScore = score
				bestPoint = image.Point{X: x, Y: y}
			}
		}
	}
	if bestScore > 2200 {
		return image.Point{}, false
	}
	return bestPoint, true
}

func collectCutoutMatchSamples(product *image.NRGBA, limit int, informativeOnly bool) []cutoutMatchSample {
	bounds := product.Bounds()
	step := max(1, int(math.Sqrt(float64(max(1, bounds.Dx()*bounds.Dy()))/float64(max(1, limit)))))
	samples := make([]cutoutMatchSample, 0, limit)
	for y := bounds.Min.Y; y < bounds.Max.Y; y += step {
		for x := bounds.Min.X; x < bounds.Max.X; x += step {
			pixel := product.NRGBAAt(x, y)
			if pixel.A < 220 {
				continue
			}
			if informativeOnly && !isInformativeMatchPixel(pixel) {
				continue
			}
			samples = append(samples, cutoutMatchSample{
				x:     x - bounds.Min.X,
				y:     y - bounds.Min.Y,
				color: pixel,
			})
			if len(samples) >= limit {
				return samples
			}
		}
	}
	return samples
}

func isInformativeMatchPixel(pixel color.NRGBA) bool {
	maxChannel := max(int(pixel.R), max(int(pixel.G), int(pixel.B)))
	minChannel := min(int(pixel.R), min(int(pixel.G), int(pixel.B)))
	return maxChannel-minChannel >= 18 || luminance(pixel) <= 238
}

func cutoutMatchScore(source *image.NRGBA, samples []cutoutMatchSample, offsetX int, offsetY int, bestScore float64) float64 {
	if len(samples) == 0 {
		return math.Inf(1)
	}
	var total float64
	sourceBounds := source.Bounds()
	for index, sample := range samples {
		x := sourceBounds.Min.X + offsetX + sample.x
		y := sourceBounds.Min.Y + offsetY + sample.y
		pixel := source.NRGBAAt(x, y)
		total += colorDistanceSquared(sample.color, pixel)
		partial := total / float64(index+1)
		if partial > bestScore*1.18 {
			return math.Inf(1)
		}
	}
	return total / float64(len(samples))
}

func colorDistanceSquared(a color.NRGBA, b color.NRGBA) float64 {
	dr := float64(a.R) - float64(b.R)
	dg := float64(a.G) - float64(b.G)
	db := float64(a.B) - float64(b.B)
	return dr*dr + dg*dg + db*db
}

func absInt(value int) int {
	if value < 0 {
		return -value
	}
	return value
}

func getAliyunImageSegClient() (*imageseg.Client, error) {
	accessKeyID := strings.TrimSpace(config.Cfg.AliyunImageSegAccessKeyID)
	accessKeySecret := strings.TrimSpace(config.Cfg.AliyunImageSegAccessKeySecret)
	endpoint := strings.TrimSpace(config.Cfg.AliyunImageSegEndpoint)
	if endpoint == "" {
		endpoint = "imageseg.cn-shanghai.aliyuncs.com"
	}
	region := strings.TrimSpace(config.Cfg.AliyunImageSegRegion)
	if region == "" {
		region = "cn-shanghai"
	}
	if accessKeyID == "" || accessKeySecret == "" {
		return nil, errors.New("阿里云商品分割缺少 AccessKey")
	}

	clientID := strings.Join([]string{accessKeyID, endpoint, region}, "\x00")
	aliyunImageSegClientMu.Lock()
	defer aliyunImageSegClientMu.Unlock()
	if aliyunImageSegClient != nil && aliyunImageSegClientID == clientID {
		return aliyunImageSegClient, nil
	}

	client, err := imageseg.NewClient(&openapi.Config{
		AccessKeyId:     tea.String(accessKeyID),
		AccessKeySecret: tea.String(accessKeySecret),
		Endpoint:        tea.String(endpoint),
		RegionId:        tea.String(region),
		Protocol:        tea.String("HTTPS"),
	})
	if err != nil {
		return nil, fmt.Errorf("创建阿里云商品分割客户端失败：%w", err)
	}
	aliyunImageSegClient = client
	aliyunImageSegClientID = clientID
	return client, nil
}

func downloadAliyunImageSegResult(ctx context.Context, url string) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: time.Duration(max(5, config.Cfg.AliyunImageSegTimeout)) * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return nil, safeMessageError{message: "阿里云商品分割结果下载失败：" + err.Error()}
	}
	defer response.Body.Close()
	if response.StatusCode >= http.StatusBadRequest {
		return nil, safeMessageError{message: fmt.Sprintf("阿里云商品分割结果下载失败：%d", response.StatusCode)}
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 64*1024*1024))
	if err != nil {
		return nil, err
	}
	if len(body) == 0 {
		return nil, safeMessageError{message: "阿里云商品分割结果为空"}
	}
	return body, nil
}

func aliyunImageSegCacheKey(data []byte) string {
	sum := sha256.Sum256(data)
	return "segment-commodity-crop-v1:" + hex.EncodeToString(sum[:])
}

func getAliyunImageSegCache(key string) *RemoveBackgroundResult {
	aliyunImageSegCache.Lock()
	defer aliyunImageSegCache.Unlock()
	return cloneRemoveBackgroundResult(aliyunImageSegCache.values[key])
}

func setAliyunImageSegCache(key string, result *RemoveBackgroundResult) {
	if result == nil {
		return
	}
	aliyunImageSegCache.Lock()
	defer aliyunImageSegCache.Unlock()
	if _, ok := aliyunImageSegCache.values[key]; !ok {
		aliyunImageSegCache.order = append(aliyunImageSegCache.order, key)
	}
	aliyunImageSegCache.values[key] = cloneRemoveBackgroundResult(result)
	for len(aliyunImageSegCache.order) > aliyunImageSegCacheLimit {
		evicted := aliyunImageSegCache.order[0]
		aliyunImageSegCache.order = aliyunImageSegCache.order[1:]
		delete(aliyunImageSegCache.values, evicted)
	}
}

func cloneRemoveBackgroundResult(result *RemoveBackgroundResult) *RemoveBackgroundResult {
	if result == nil {
		return nil
	}
	cloned := *result
	cloned.Image = append([]byte(nil), result.Image...)
	return &cloned
}

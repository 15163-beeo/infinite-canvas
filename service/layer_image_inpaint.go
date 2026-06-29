package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
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
	"path/filepath"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
)

func refineLayerImageBackgroundWithImageModel(ctx context.Context, filename string, contentType string, data []byte, product []byte, meta layerImageMeta, textLayers []LayerImageTextLayer, options LayerImageOptions) ([]byte, error) {
	modelName := strings.TrimSpace(options.Model)
	if modelName == "" {
		return nil, errors.New("智能分层背景修复未配置图像模型")
	}
	channel, err := removeBackgroundImageModelChannel(modelName, options)
	if err != nil {
		return nil, err
	}

	mask, err := buildLayerImageInpaintMask(product, meta, textLayers)
	if err != nil {
		return nil, err
	}
	result, err := requestLayerImageBackgroundEditWithMagentaMask(ctx, filename, contentType, data, mask, modelName, channel)
	if err != nil {
		log.Printf("layer image magenta background inpaint failed, retry with edit mask: %v", err)
		result, err = requestLayerImageBackgroundEdit(ctx, filename, contentType, data, mask, modelName, channel)
	}
	if err != nil {
		log.Printf("layer image masked background inpaint failed, retry without mask: %v", err)
		result, err = requestLayerImageBackgroundEdit(ctx, filename, contentType, data, nil, modelName, channel)
	}
	if err != nil {
		return nil, err
	}
	return normalizeLayerImageBackgroundEditResult(result, meta.OriginalWidth, meta.OriginalHeight)
}

func requestLayerImageBackgroundEditWithMagentaMask(ctx context.Context, filename string, contentType string, data []byte, mask []byte, modelName string, channel model.ModelChannel) ([]byte, error) {
	if len(mask) == 0 {
		return nil, errors.New("智能分层背景修复遮罩为空")
	}
	magentaInput, err := buildLayerImageMagentaInput(data, mask)
	if err != nil {
		return nil, err
	}
	return requestLayerImageBackgroundEditWithPrompt(ctx, filename, "image/png", magentaInput, nil, modelName, channel, layerImageMagentaInpaintPrompt())
}

func requestLayerImageBackgroundEdit(ctx context.Context, filename string, contentType string, data []byte, mask []byte, modelName string, channel model.ModelChannel) ([]byte, error) {
	return requestLayerImageBackgroundEditWithPrompt(ctx, filename, contentType, data, mask, modelName, channel, layerImageBackgroundInpaintPrompt(mask != nil))
}

func requestLayerImageBackgroundEditWithPrompt(ctx context.Context, filename string, contentType string, data []byte, mask []byte, modelName string, channel model.ModelChannel, prompt string) ([]byte, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	fields := map[string]string{
		"model":         modelName,
		"prompt":        prompt,
		"output_format": "png",
	}
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			return nil, err
		}
	}
	imagePart, err := writer.CreateFormFile("image", safeLayerImageEditFilename(filename, contentType))
	if err != nil {
		return nil, err
	}
	if _, err := imagePart.Write(data); err != nil {
		return nil, err
	}
	if len(mask) > 0 {
		maskPart, err := writer.CreateFormFile("mask", "layer-background-mask.png")
		if err != nil {
			return nil, err
		}
		if _, err := maskPart.Write(mask); err != nil {
			return nil, err
		}
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
		return nil, safeMessageError{message: "智能分层背景修复请求失败：" + err.Error()}
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode >= http.StatusBadRequest {
		return nil, imageEditError{status: response.StatusCode, body: responseBody}
	}
	result, err := parseImageEditResult(ctx, channel, responseBody)
	if err != nil {
		return nil, safeMessageError{message: "智能分层背景修复结果解析失败：" + err.Error()}
	}
	return result, nil
}

func layerImageMagentaInpaintPrompt() string {
	return `图中洋红色区域（RGB 255,0,255）是前景商品或可读文字被移除后的空白。
任务：只用周围背景补全所有洋红色区域，使画面自然完整。
规则：
- 只处理洋红色区域；非洋红区域的图标、色块、线条、底部横幅、品牌图形、装饰元素和背景纹理必须保持原样。
- 洋红区域内不要放置任何商品、人物、可读文字、Logo、价格、按钮或新图标。
- 观察洋红色周围的背景、渐变、网格、边框和光照，将其自然延伸到洋红区域内。
- 不要留下洋红色、阴影、残影、轮廓、马赛克或涂抹痕迹。
输出修复后的完整图片，保持原图尺寸和构图。`
}

func layerImageBackgroundInpaintPrompt(hasMask bool) string {
	maskInstruction := ""
	if hasMask {
		maskInstruction = "只编辑 mask 透明区域；未遮罩区域的图标、色块、线条、底部横幅、品牌图形、装饰元素和背景纹理必须保持原样。"
	}
	return `为电商图片智能分层生成“纯背景层”。
只移除被遮罩覆盖的可售商品主体和可读文字，保留未遮罩区域的版式、色彩、光照、渐变、纹理、图标、色块、边框、横幅和装饰图形。
自然补全被移除区域，不要生成新的商品、文字、Logo、价格、按钮或图标，不要留下阴影、残影、轮廓、马赛克或涂抹痕迹。
输出必须是完整背景图，保持原图画布比例和边缘构图。` + maskInstruction
}

func buildLayerImageMagentaInput(data []byte, mask []byte) ([]byte, error) {
	decoded, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	sourceBounds := decoded.Bounds()
	output := image.NewNRGBA(image.Rect(0, 0, sourceBounds.Dx(), sourceBounds.Dy()))
	draw.Draw(output, output.Bounds(), decoded, sourceBounds.Min, draw.Src)

	decodedMask, _, err := image.Decode(bytes.NewReader(mask))
	if err != nil {
		return nil, err
	}
	maskBounds := decodedMask.Bounds()
	for y := 0; y < output.Bounds().Dy(); y++ {
		maskY := maskBounds.Min.Y + min(maskBounds.Dy()-1, max(0, int(math.Round(float64(y)*float64(maskBounds.Dy()-1)/float64(max(1, output.Bounds().Dy()-1))))))
		for x := 0; x < output.Bounds().Dx(); x++ {
			maskX := maskBounds.Min.X + min(maskBounds.Dx()-1, max(0, int(math.Round(float64(x)*float64(maskBounds.Dx()-1)/float64(max(1, output.Bounds().Dx()-1))))))
			_, _, _, alpha := decodedMask.At(maskX, maskY).RGBA()
			if alpha >= 128*257 {
				continue
			}
			output.SetNRGBA(x, y, color.NRGBA{R: 255, G: 0, B: 255, A: 255})
		}
	}
	return encodeNRGBAPNG(output)
}

func buildLayerImageInpaintMask(product []byte, meta layerImageMeta, textLayers []LayerImageTextLayer) ([]byte, error) {
	width := max(1, meta.OriginalWidth)
	height := max(1, meta.OriginalHeight)
	mask := image.NewNRGBA(image.Rect(0, 0, width, height))
	draw.Draw(mask, mask.Bounds(), &image.Uniform{C: color.NRGBA{R: 255, G: 255, B: 255, A: 255}}, image.Point{}, draw.Src)

	if len(product) > 0 {
		if productImage, _, err := image.Decode(bytes.NewReader(product)); err == nil {
			productBounds := productImage.Bounds()
			for y := 0; y < meta.ProductHeight; y++ {
				for x := 0; x < meta.ProductWidth; x++ {
					sourceX := productBounds.Min.X + min(productBounds.Dx()-1, max(0, int(math.Round(float64(x)*float64(productBounds.Dx()-1)/float64(max(1, meta.ProductWidth-1))))))
					sourceY := productBounds.Min.Y + min(productBounds.Dy()-1, max(0, int(math.Round(float64(y)*float64(productBounds.Dy()-1)/float64(max(1, meta.ProductHeight-1))))))
					_, _, _, alpha := productImage.At(sourceX, sourceY).RGBA()
					if alpha < 24*257 {
						continue
					}
					targetX := meta.ProductOffsetX + x
					targetY := meta.ProductOffsetY + y
					if targetX < 0 || targetX >= width || targetY < 0 || targetY >= height {
						continue
					}
					mask.SetNRGBA(targetX, targetY, color.NRGBA{R: 0, G: 0, B: 0, A: 0})
				}
			}
		}
	}

	for _, layer := range textLayers {
		rect := layerImageTextInpaintRect(layer, width, height)
		padding := max(3, min(width, height)/140)
		rect = expandRect(rect, padding, mask.Bounds())
		for y := rect.Min.Y; y < rect.Max.Y; y++ {
			for x := rect.Min.X; x < rect.Max.X; x++ {
				mask.SetNRGBA(x, y, color.NRGBA{R: 0, G: 0, B: 0, A: 0})
			}
		}
	}

	dilateTransparentMask(mask, max(2, min(width, height)/160))
	var output bytes.Buffer
	if err := png.Encode(&output, mask); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func layerImageTextInpaintRect(layer LayerImageTextLayer, canvasWidth int, canvasHeight int) image.Rectangle {
	rect := image.Rect(
		int(math.Floor(layer.Position.X)),
		int(math.Floor(layer.Position.Y)),
		int(math.Ceil(layer.Position.X+layer.Size.Width)),
		int(math.Ceil(layer.Position.Y+layer.Size.Height)),
	)
	if canvasWidth <= 0 || canvasHeight <= 0 {
		return rect
	}

	width := math.Max(1, layer.Size.Width)
	height := math.Max(1, layer.Size.Height)
	centerX := layer.Position.X + width/2
	centerY := layer.Position.Y + height/2
	isCompactTopBadgeText := centerY <= float64(canvasHeight)*0.09 &&
		centerX >= float64(canvasWidth)*0.32 &&
		centerX <= float64(canvasWidth)*0.55 &&
		width <= float64(canvasWidth)*0.16 &&
		height <= float64(canvasHeight)*0.04
	if isCompactTopBadgeText {
		return image.Rect(
			int(math.Floor(layer.Position.X-float64(canvasWidth)*0.035)),
			int(math.Floor(layer.Position.Y-float64(canvasHeight)*0.018)),
			int(math.Ceil(layer.Position.X+width+float64(canvasWidth)*0.025)),
			int(math.Ceil(layer.Position.Y+height+float64(canvasHeight)*0.028)),
		).Intersect(image.Rect(0, 0, canvasWidth, canvasHeight))
	}
	return rect.Intersect(image.Rect(0, 0, canvasWidth, canvasHeight))
}

func dilateTransparentMask(mask *image.NRGBA, radius int) {
	if radius <= 0 {
		return
	}
	bounds := mask.Bounds()
	source := cloneNRGBA(mask)
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			transparent := false
			for yy := max(bounds.Min.Y, y-radius); yy <= min(bounds.Max.Y-1, y+radius) && !transparent; yy++ {
				for xx := max(bounds.Min.X, x-radius); xx <= min(bounds.Max.X-1, x+radius); xx++ {
					if source.NRGBAAt(xx, yy).A < 128 {
						transparent = true
						break
					}
				}
			}
			if transparent {
				mask.SetNRGBA(x, y, color.NRGBA{R: 0, G: 0, B: 0, A: 0})
			}
		}
	}
}

func normalizeLayerImageBackgroundEditResult(data []byte, width int, height int) ([]byte, error) {
	decoded, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	width = max(1, width)
	height = max(1, height)
	bounds := decoded.Bounds()
	rgba := image.NewNRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	draw.Draw(rgba, rgba.Bounds(), decoded, bounds.Min, draw.Src)
	if rgba.Bounds().Dx() != width || rgba.Bounds().Dy() != height {
		rgba = resizeNRGBANearest(rgba, width, height)
	}
	return encodeNRGBAPNG(rgba)
}

func resizeNRGBANearest(source *image.NRGBA, width int, height int) *image.NRGBA {
	output := image.NewNRGBA(image.Rect(0, 0, width, height))
	sourceBounds := source.Bounds()
	for y := 0; y < height; y++ {
		sourceY := sourceBounds.Min.Y + min(sourceBounds.Dy()-1, max(0, int(math.Round(float64(y)*float64(sourceBounds.Dy()-1)/float64(max(1, height-1))))))
		for x := 0; x < width; x++ {
			sourceX := sourceBounds.Min.X + min(sourceBounds.Dx()-1, max(0, int(math.Round(float64(x)*float64(sourceBounds.Dx()-1)/float64(max(1, width-1))))))
			output.SetNRGBA(x, y, source.NRGBAAt(sourceX, sourceY))
		}
	}
	return output
}

func safeLayerImageEditFilename(filename string, contentType string) string {
	cleaned := strings.TrimSpace(filepath.Base(filename))
	if cleaned != "" && cleaned != "." && cleaned != string(filepath.Separator) {
		return cleaned
	}
	return "layer-image-input" + imageExtByMime(contentType, "")
}

func decodeLayerImageEditDataURL(value string) ([]byte, bool) {
	if !strings.HasPrefix(value, "data:image/") {
		return nil, false
	}
	data, err := base64.StdEncoding.DecodeString(stripDataURLPrefix(value))
	return data, err == nil
}

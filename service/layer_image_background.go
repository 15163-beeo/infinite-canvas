package service

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"log"
	"math"
)

func layerImageWithAliyunImageSeg(ctx context.Context, filename string, contentType string, data []byte, options ...LayerImageOptions) (*LayerImageResult, error) {
	var result *RemoveBackgroundResult
	if len(options) > 0 {
		if focusBox, err := detectLayerImageFocusBoxForOriginal(ctx, data, contentType, options[0]); err != nil {
			log.Printf("layer image focus detection skipped: %v", err)
		} else if focusBox != nil {
			if focusedResult, err := removeBackgroundWithFocusedAliyunImageSeg(ctx, filename, data, focusBox); err == nil {
				result = focusedResult
			} else {
				log.Printf("focused aliyun imageseg layer image failed, fallback: %v", err)
			}
		}
	}
	var err error
	if result == nil {
		result, err = removeBackgroundWithAliyunImageSeg(ctx, filename, contentType, data)
	}
	if err != nil {
		return nil, err
	}
	background, err := buildBackgroundFromLayerCutout(data, result)
	if err != nil {
		return nil, err
	}
	return &LayerImageResult{
		Background:     background,
		Product:        result.Image,
		OriginalWidth:  result.OriginalWidth,
		OriginalHeight: result.OriginalHeight,
		ProductOffsetX: result.ProductOffsetX,
		ProductOffsetY: result.ProductOffsetY,
		ProductWidth:   result.ProductWidth,
		ProductHeight:  result.ProductHeight,
	}, nil
}

func buildBackgroundFromLayerCutout(sourceData []byte, product *RemoveBackgroundResult) ([]byte, error) {
	if product == nil || len(product.Image) == 0 {
		return nil, errors.New("主体图为空")
	}
	source, sourceWidth, sourceHeight := decodeNRGBAImage(sourceData)
	if source == nil || sourceWidth <= 0 || sourceHeight <= 0 {
		return nil, errors.New("原图解析失败")
	}
	output := cloneNRGBA(source)
	rect := image.Rect(
		product.ProductOffsetX,
		product.ProductOffsetY,
		product.ProductOffsetX+product.ProductWidth,
		product.ProductOffsetY+product.ProductHeight,
	).Intersect(output.Bounds())
	if rect.Empty() {
		return encodeNRGBAPNG(output)
	}
	padding := max(4, min(sourceWidth, sourceHeight)/120)
	rect = expandRect(rect, padding, output.Bounds())
	fillRectWithSurrounding(output, rect)
	blurRect(output, rect, max(1, min(rect.Dx(), rect.Dy())/40))
	return encodeNRGBAPNG(output)
}

func removeTextLayersFromBackground(background []byte, textLayers []LayerImageTextLayer) ([]byte, error) {
	if len(background) == 0 || len(textLayers) == 0 {
		return background, nil
	}
	decoded, _, err := image.Decode(bytes.NewReader(background))
	if err != nil {
		return nil, err
	}
	bounds := decoded.Bounds()
	output := image.NewNRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	draw.Draw(output, output.Bounds(), decoded, bounds.Min, draw.Src)
	for _, layer := range textLayers {
		rect := image.Rect(
			int(math.Floor(layer.Position.X)),
			int(math.Floor(layer.Position.Y)),
			int(math.Ceil(layer.Position.X+layer.Size.Width)),
			int(math.Ceil(layer.Position.Y+layer.Size.Height)),
		).Intersect(output.Bounds())
		if rect.Empty() {
			continue
		}
		padding := max(3, min(output.Bounds().Dx(), output.Bounds().Dy())/180)
		rect = expandRect(rect, padding, output.Bounds())
		fillRectWithSurrounding(output, rect)
		blurRect(output, rect, max(1, min(rect.Dx(), rect.Dy())/22))
	}
	return encodeNRGBAPNG(output)
}

func cloneNRGBA(source *image.NRGBA) *image.NRGBA {
	output := image.NewNRGBA(source.Bounds())
	copy(output.Pix, source.Pix)
	return output
}

func expandRect(rect image.Rectangle, padding int, bounds image.Rectangle) image.Rectangle {
	return image.Rect(rect.Min.X-padding, rect.Min.Y-padding, rect.Max.X+padding, rect.Max.Y+padding).Intersect(bounds)
}

func fillRectWithSurrounding(output *image.NRGBA, rect image.Rectangle) {
	bounds := output.Bounds()
	for y := rect.Min.Y; y < rect.Max.Y; y++ {
		for x := rect.Min.X; x < rect.Max.X; x++ {
			horizontal, hasHorizontal := surroundingHorizontalColor(output, rect, bounds, x, y)
			vertical, hasVertical := surroundingVerticalColor(output, rect, bounds, x, y)
			switch {
			case hasHorizontal && hasVertical:
				output.SetNRGBA(x, y, averageNRGBA(horizontal, vertical))
			case hasHorizontal:
				output.SetNRGBA(x, y, horizontal)
			case hasVertical:
				output.SetNRGBA(x, y, vertical)
			default:
				output.SetNRGBA(x, y, averageBorderColor(output, rect, bounds))
			}
		}
	}
}

func surroundingHorizontalColor(imageData *image.NRGBA, rect image.Rectangle, bounds image.Rectangle, x int, y int) (color.NRGBA, bool) {
	leftX := rect.Min.X - 1
	rightX := rect.Max.X
	hasLeft := leftX >= bounds.Min.X
	hasRight := rightX < bounds.Max.X
	switch {
	case hasLeft && hasRight:
		ratio := float64(x-rect.Min.X) / math.Max(1, float64(rect.Dx()-1))
		return mixNRGBA(imageData.NRGBAAt(leftX, y), imageData.NRGBAAt(rightX, y), ratio), true
	case hasLeft:
		return imageData.NRGBAAt(leftX, y), true
	case hasRight:
		return imageData.NRGBAAt(rightX, y), true
	default:
		return color.NRGBA{}, false
	}
}

func surroundingVerticalColor(imageData *image.NRGBA, rect image.Rectangle, bounds image.Rectangle, x int, y int) (color.NRGBA, bool) {
	topY := rect.Min.Y - 1
	bottomY := rect.Max.Y
	hasTop := topY >= bounds.Min.Y
	hasBottom := bottomY < bounds.Max.Y
	switch {
	case hasTop && hasBottom:
		ratio := float64(y-rect.Min.Y) / math.Max(1, float64(rect.Dy()-1))
		return mixNRGBA(imageData.NRGBAAt(x, topY), imageData.NRGBAAt(x, bottomY), ratio), true
	case hasTop:
		return imageData.NRGBAAt(x, topY), true
	case hasBottom:
		return imageData.NRGBAAt(x, bottomY), true
	default:
		return color.NRGBA{}, false
	}
}

func averageBorderColor(imageData *image.NRGBA, rect image.Rectangle, bounds image.Rectangle) color.NRGBA {
	var red, green, blue, alpha, count int
	add := func(x int, y int) {
		if x < bounds.Min.X || x >= bounds.Max.X || y < bounds.Min.Y || y >= bounds.Max.Y {
			return
		}
		pixel := imageData.NRGBAAt(x, y)
		red += int(pixel.R)
		green += int(pixel.G)
		blue += int(pixel.B)
		alpha += int(pixel.A)
		count++
	}
	for x := rect.Min.X; x < rect.Max.X; x++ {
		add(x, rect.Min.Y-1)
		add(x, rect.Max.Y)
	}
	for y := rect.Min.Y; y < rect.Max.Y; y++ {
		add(rect.Min.X-1, y)
		add(rect.Max.X, y)
	}
	if count == 0 {
		return color.NRGBA{A: 255}
	}
	return color.NRGBA{R: uint8(red / count), G: uint8(green / count), B: uint8(blue / count), A: uint8(alpha / count)}
}

func mixNRGBA(a color.NRGBA, b color.NRGBA, ratio float64) color.NRGBA {
	ratio = math.Max(0, math.Min(1, ratio))
	inv := 1 - ratio
	return color.NRGBA{
		R: uint8(math.Round(float64(a.R)*inv + float64(b.R)*ratio)),
		G: uint8(math.Round(float64(a.G)*inv + float64(b.G)*ratio)),
		B: uint8(math.Round(float64(a.B)*inv + float64(b.B)*ratio)),
		A: uint8(math.Round(float64(a.A)*inv + float64(b.A)*ratio)),
	}
}

func averageNRGBA(a color.NRGBA, b color.NRGBA) color.NRGBA {
	return color.NRGBA{
		R: uint8((int(a.R) + int(b.R)) / 2),
		G: uint8((int(a.G) + int(b.G)) / 2),
		B: uint8((int(a.B) + int(b.B)) / 2),
		A: uint8((int(a.A) + int(b.A)) / 2),
	}
}

func blurRect(imageData *image.NRGBA, rect image.Rectangle, radius int) {
	if radius <= 0 || rect.Empty() {
		return
	}
	source := cloneNRGBA(imageData)
	bounds := imageData.Bounds()
	for y := rect.Min.Y; y < rect.Max.Y; y++ {
		for x := rect.Min.X; x < rect.Max.X; x++ {
			var red, green, blue, alpha, count int
			for yy := max(bounds.Min.Y, y-radius); yy <= min(bounds.Max.Y-1, y+radius); yy++ {
				for xx := max(bounds.Min.X, x-radius); xx <= min(bounds.Max.X-1, x+radius); xx++ {
					pixel := source.NRGBAAt(xx, yy)
					red += int(pixel.R)
					green += int(pixel.G)
					blue += int(pixel.B)
					alpha += int(pixel.A)
					count++
				}
			}
			count = max(1, count)
			imageData.SetNRGBA(x, y, color.NRGBA{R: uint8(red / count), G: uint8(green / count), B: uint8(blue / count), A: uint8(alpha / count)})
		}
	}
}

func encodeNRGBAPNG(imageData *image.NRGBA) ([]byte, error) {
	var output bytes.Buffer
	if err := png.Encode(&output, imageData); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

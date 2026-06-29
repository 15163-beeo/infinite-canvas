package service

import (
	"bytes"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"testing"
)

func TestNormalizeTransparentCutout_ConvertsOpaqueCheckerboardBackdrop(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 240, 240))
	for y := 0; y < 240; y++ {
		for x := 0; x < 240; x++ {
			tone := uint8(235)
			if ((x/24)+(y/24))%2 == 0 {
				tone = 255
			}
			source.SetNRGBA(x, y, color.NRGBA{R: tone, G: tone, B: tone, A: 255})
		}
	}
	for y := 42; y < 210; y++ {
		for x := 64; x < 196; x++ {
			source.SetNRGBA(x, y, color.NRGBA{R: 20, G: 70, B: 190, A: 255})
		}
	}

	var encoded bytes.Buffer
	if err := png.Encode(&encoded, source); err != nil {
		t.Fatalf("encode source: %v", err)
	}

	result, err := normalizeTransparentCutout(encoded.Bytes(), encoded.Bytes())
	if err != nil {
		t.Fatalf("normalize cutout: %v", err)
	}

	decoded, err := png.Decode(bytes.NewReader(result.Image))
	if err != nil {
		t.Fatalf("decode result: %v", err)
	}

	bounds := decoded.Bounds()
	if bounds.Dx() >= 240 || bounds.Dy() >= 240 {
		t.Fatalf("expected cropped result, got bounds=%v", bounds)
	}

	nrgba := image.NewNRGBA(bounds)
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			nrgba.Set(x, y, decoded.At(x, y))
		}
	}
	if bounds.Dx() != 132 || bounds.Dy() != 168 {
		t.Fatalf("expected cropped subject bounds 132x168, got=%dx%d", bounds.Dx(), bounds.Dy())
	}
	center := nrgba.NRGBAAt(bounds.Min.X+bounds.Dx()/2, bounds.Min.Y+bounds.Dy()/2)
	if center.A < 240 {
		t.Fatalf("expected solid subject center, got alpha=%d", center.A)
	}
}

func TestNormalizeTransparentCutout_FillsInteriorTransparentHoles(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 180, 180))
	for y := 0; y < 180; y++ {
		for x := 0; x < 180; x++ {
			source.SetNRGBA(x, y, color.NRGBA{R: 245, G: 248, B: 255, A: 255})
		}
	}
	for y := 32; y < 150; y++ {
		for x := 42; x < 138; x++ {
			source.SetNRGBA(x, y, color.NRGBA{R: 24, G: 92, B: 210, A: 255})
		}
	}
	for y := 78; y < 118; y++ {
		for x := 62; x < 118; x++ {
			source.SetNRGBA(x, y, color.NRGBA{R: 255, G: 255, B: 255, A: 255})
		}
	}

	resultImage := image.NewNRGBA(source.Bounds())
	draw.Draw(resultImage, resultImage.Bounds(), source, image.Point{}, draw.Src)
	for y := 0; y < 180; y++ {
		for x := 0; x < 180; x++ {
			pixel := resultImage.NRGBAAt(x, y)
			if x < 42 || x >= 138 || y < 32 || y >= 150 || (x >= 62 && x < 118 && y >= 78 && y < 118) {
				pixel.A = 0
				resultImage.SetNRGBA(x, y, pixel)
			}
		}
	}

	var encodedResult bytes.Buffer
	if err := png.Encode(&encodedResult, resultImage); err != nil {
		t.Fatalf("encode result: %v", err)
	}
	var encodedSource bytes.Buffer
	if err := png.Encode(&encodedSource, source); err != nil {
		t.Fatalf("encode source: %v", err)
	}

	result, err := normalizeTransparentCutout(encodedResult.Bytes(), encodedSource.Bytes())
	if err != nil {
		t.Fatalf("normalize cutout: %v", err)
	}

	decoded, err := png.Decode(bytes.NewReader(result.Image))
	if err != nil {
		t.Fatalf("decode result: %v", err)
	}
	bounds := decoded.Bounds()
	nrgba := image.NewNRGBA(bounds)
	draw.Draw(nrgba, bounds, decoded, bounds.Min, draw.Src)
	center := nrgba.NRGBAAt(bounds.Min.X+bounds.Dx()/2, bounds.Min.Y+bounds.Dy()/2)
	if center.A < 240 {
		t.Fatalf("expected interior hole to be filled, got alpha=%d", center.A)
	}
	if center.R < 240 || center.G < 240 || center.B < 240 {
		t.Fatalf("expected source color to be preserved, got=%v", center)
	}
}

func TestNormalizeTransparentCutout_PreservesWhiteProductOnCheckerboard(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 260, 260))
	for y := 0; y < 260; y++ {
		for x := 0; x < 260; x++ {
			tone := uint8(237)
			if ((x/25)+(y/25))%2 == 1 {
				tone = 254
			}
			source.SetNRGBA(x, y, color.NRGBA{R: tone, G: tone, B: tone, A: 255})
		}
	}
	for y := 48; y < 112; y++ {
		for x := 56; x < 210; x++ {
			source.SetNRGBA(x, y, color.NRGBA{R: 18, G: 92, B: 220, A: 255})
		}
	}
	for y := 112; y < 224; y++ {
		for x := 56; x < 210; x++ {
			source.SetNRGBA(x, y, color.NRGBA{R: 252, G: 252, B: 250, A: 255})
		}
	}
	for y := 150; y < 170; y++ {
		for x := 88; x < 178; x++ {
			source.SetNRGBA(x, y, color.NRGBA{R: 12, G: 42, B: 150, A: 255})
		}
	}

	var encoded bytes.Buffer
	if err := png.Encode(&encoded, source); err != nil {
		t.Fatalf("encode source: %v", err)
	}

	result, err := normalizeTransparentCutout(encoded.Bytes(), encoded.Bytes())
	if err != nil {
		t.Fatalf("normalize cutout: %v", err)
	}

	decoded, err := png.Decode(bytes.NewReader(result.Image))
	if err != nil {
		t.Fatalf("decode result: %v", err)
	}
	bounds := decoded.Bounds()
	nrgba := image.NewNRGBA(bounds)
	draw.Draw(nrgba, bounds, decoded, bounds.Min, draw.Src)
	center := nrgba.NRGBAAt(bounds.Min.X+bounds.Dx()/2, bounds.Min.Y+((190-48)*bounds.Dy())/(224-48))
	if center.A < 240 {
		t.Fatalf("expected white product panel to stay opaque, got alpha=%d", center.A)
	}
	if center.R < 235 || center.G < 235 || center.B < 235 {
		t.Fatalf("expected white product panel color to stay, got=%v", center)
	}
	if bounds.Dx() >= 260 || bounds.Dy() >= 260 {
		t.Fatalf("expected checkerboard background to be removed and cropped, got bounds=%v", bounds)
	}
}

func TestNormalizeTransparentCutout_RemovesChromaKeyAndPreservesGreenLabel(t *testing.T) {
	source := image.NewNRGBA(image.Rect(0, 0, 260, 260))
	for y := 0; y < 260; y++ {
		for x := 0; x < 260; x++ {
			source.SetNRGBA(x, y, color.NRGBA{R: 0, G: 255, B: 0, A: 255})
		}
	}
	for y := 48; y < 224; y++ {
		for x := 56; x < 210; x++ {
			source.SetNRGBA(x, y, color.NRGBA{R: 252, G: 252, B: 250, A: 255})
		}
	}
	for y := 70; y < 112; y++ {
		for x := 56; x < 210; x++ {
			source.SetNRGBA(x, y, color.NRGBA{R: 24, G: 92, B: 220, A: 255})
		}
	}
	for y := 142; y < 164; y++ {
		for x := 94; x < 178; x++ {
			source.SetNRGBA(x, y, color.NRGBA{R: 60, G: 180, B: 40, A: 255})
		}
	}

	var encoded bytes.Buffer
	if err := png.Encode(&encoded, source); err != nil {
		t.Fatalf("encode source: %v", err)
	}

	result, err := normalizeTransparentCutout(encoded.Bytes(), encoded.Bytes())
	if err != nil {
		t.Fatalf("normalize cutout: %v", err)
	}

	decoded, err := png.Decode(bytes.NewReader(result.Image))
	if err != nil {
		t.Fatalf("decode result: %v", err)
	}
	bounds := decoded.Bounds()
	if bounds.Dx() >= 260 || bounds.Dy() >= 260 {
		t.Fatalf("expected chroma key background to be removed and cropped, got bounds=%v", bounds)
	}
	nrgba := image.NewNRGBA(bounds)
	draw.Draw(nrgba, bounds, decoded, bounds.Min, draw.Src)
	whitePanel := nrgba.NRGBAAt(bounds.Min.X+bounds.Dx()/2, bounds.Min.Y+120)
	if whitePanel.A < 240 || whitePanel.R < 235 || whitePanel.G < 235 || whitePanel.B < 235 {
		t.Fatalf("expected white product panel to stay opaque, got=%v", whitePanel)
	}
	greenLabel := nrgba.NRGBAAt(bounds.Min.X+bounds.Dx()/2, bounds.Min.Y+105)
	if greenLabel.A < 240 || greenLabel.G < 140 {
		t.Fatalf("expected product green label to stay opaque, got=%v", greenLabel)
	}
}

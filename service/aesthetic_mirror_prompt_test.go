package service

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"
)

func TestParseAestheticMirrorReferenceRules(t *testing.T) {
	parsed := parseAestheticMirrorReferenceRules("图2/3/5不需要出现产品；图4做医生背书；整体偏蓝白医疗感")
	if parsed.GlobalExtraPrompt != "整体偏蓝白医疗感" {
		t.Fatalf("unexpected global extra prompt: %q", parsed.GlobalExtraPrompt)
	}
	for _, index := range []int{1, 2, 4} {
		if parsed.Rules[index].ProductPresence != aestheticMirrorProductForbidden {
			t.Fatalf("reference %d expected forbidden product, got %+v", index, parsed.Rules[index])
		}
	}
	if parsed.Rules[3].LayoutType != aestheticMirrorDoctorEndorsementLayout {
		t.Fatalf("reference 3 expected doctor endorsement, got %+v", parsed.Rules[3])
	}
	if parsed.Rules[3].ProductPresence != aestheticMirrorProductOptional {
		t.Fatalf("reference 3 expected optional product, got %+v", parsed.Rules[3])
	}
}

func TestBuildAestheticMirrorTaskPromptPrefersExplicitRule(t *testing.T) {
	prompt := buildAestheticMirrorTaskPrompt(
		"base prompt",
		1,
		0,
		aestheticMirrorReferenceRule{ProductPresence: aestheticMirrorProductForbidden, LayoutType: aestheticMirrorDoctorEndorsementLayout},
		&aestheticMirrorReferenceAnalysis{
			LayoutType:      aestheticMirrorProductHeroLayout,
			ProductPresence: aestheticMirrorProductRequired,
			Summary:         "医生背书说明图",
			KeyElements:     []string{"医生人物", "背书文案"},
		},
	)
	if !strings.Contains(prompt, "不需要出现产品") {
		t.Fatalf("expected forbidden product rule in prompt: %s", prompt)
	}
	if !strings.Contains(prompt, "医生或专家背书") {
		t.Fatalf("expected doctor layout rule in prompt: %s", prompt)
	}
	if strings.Contains(prompt, "产品主视觉海报") {
		t.Fatalf("explicit rule should override analysis layout: %s", prompt)
	}
}

func TestValidateAestheticMirrorResultDimensions(t *testing.T) {
	dataURL := testAestheticMirrorPNGDataURL(t, 12, 16)
	if _, err := validateAestheticMirrorResultDimensions(dataURL, "3:4", "12x16"); err != nil {
		t.Fatalf("expected matching size to pass: %v", err)
	}
	if _, err := validateAestheticMirrorResultDimensions(dataURL, "3:4", "16x16"); err == nil || !strings.Contains(err.Error(), "比例不匹配") {
		t.Fatalf("expected aspect mismatch error, got %v", err)
	}
	legacyCompatible := testAestheticMirrorPNGDataURL(t, 8, 12)
	if _, err := validateAestheticMirrorResultDimensions(legacyCompatible, "3:4", "8x12"); err != nil {
		t.Fatalf("expected upstream size ratio to pass legacy-compatible shape: %v", err)
	}
}

func testAestheticMirrorPNGDataURL(t *testing.T, width int, height int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, width, height))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buffer.Bytes())
}

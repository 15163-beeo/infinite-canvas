package service

import (
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

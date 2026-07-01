package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

type aestheticMirrorProductPresence string
type aestheticMirrorLayoutType string

const (
	aestheticMirrorProductRequired  aestheticMirrorProductPresence = "required"
	aestheticMirrorProductOptional  aestheticMirrorProductPresence = "optional"
	aestheticMirrorProductForbidden aestheticMirrorProductPresence = "forbidden"

	aestheticMirrorProductHeroLayout       aestheticMirrorLayoutType = "product_hero"
	aestheticMirrorSymptomGridLayout       aestheticMirrorLayoutType = "symptom_grid"
	aestheticMirrorDoctorEndorsementLayout aestheticMirrorLayoutType = "doctor_endorsement"
	aestheticMirrorMechanismLayout         aestheticMirrorLayoutType = "mechanism"
	aestheticMirrorDataProofLayout         aestheticMirrorLayoutType = "data_proof"
	aestheticMirrorComparisonLayout        aestheticMirrorLayoutType = "comparison"
)

type aestheticMirrorReferenceRule struct {
	ProductPresence aestheticMirrorProductPresence
	LayoutType      aestheticMirrorLayoutType
}

type aestheticMirrorParsedRules struct {
	GlobalExtraPrompt string
	Rules             map[int]aestheticMirrorReferenceRule
}

type aestheticMirrorReferenceAnalysis struct {
	LayoutType      aestheticMirrorLayoutType
	ProductPresence aestheticMirrorProductPresence
	Summary         string
	KeyElements     []string
}

var (
	aestheticMirrorReferenceIndexesPattern = regexp.MustCompile(`(?:图|第)\s*([0-9][0-9/、,，及和\s]*)\s*(?:张|图)?`)
	aestheticMirrorNoProductPattern        = regexp.MustCompile(`不需要出现产品|不要出现产品|无需出现产品|不需要产品|不要产品|无产品|不出产品|不放产品|产品不用出现`)
	aestheticMirrorNeedProductPattern      = regexp.MustCompile(`需要出现产品|必须出现产品|要出现产品|必须有产品|需要产品|要有产品|必须放产品|产品必须出现`)
	aestheticMirrorDoctorPattern           = regexp.MustCompile(`医生背书|医生图|专家背书|专家图|医师背书|临床背书|权威背书|医师图|专家肖像|医生肖像`)
	aestheticMirrorSymptomPattern          = regexp.MustCompile(`症状拼图|症状图|问题拼图|场景拼图|多宫格|九宫格|拼图|痛点图|问题图`)
	aestheticMirrorMechanismPattern        = regexp.MustCompile(`机理图|原理图|成分机理图|成分图|配方图|机制图|作用路径|分子图`)
	aestheticMirrorDataProofPattern        = regexp.MustCompile(`数据证明图|数据图|检测图|证书图|证明图|认证图|实验图|报告图|检测证明|临床数据`)
	aestheticMirrorComparisonPattern       = regexp.MustCompile(`对比图|前后对比|前后对照|对照图|对比说明`)
	aestheticMirrorProductHeroPattern      = regexp.MustCompile(`主图|主视觉|单品海报|卖点海报|单瓶海报|产品海报|产品主视觉`)
	aestheticMirrorLayoutCleanupPattern    = regexp.MustCompile(`(?:做|走|改成|做成|出成)?(?:医生背书|医生图|专家背书|专家图|医师背书|临床背书|权威背书|医师图|专家肖像|医生肖像|症状拼图|症状图|问题拼图|场景拼图|多宫格|九宫格|拼图|痛点图|问题图|机理图|原理图|成分机理图|成分图|配方图|机制图|作用路径|分子图|数据证明图|数据图|检测图|证书图|证明图|认证图|实验图|报告图|检测证明|临床数据|对比图|前后对比|前后对照|对照图|对比说明|主图|主视觉|单品海报|卖点海报|单瓶海报|产品海报|产品主视觉)`)
	aestheticMirrorSplitRunes              = map[rune]bool{'\n': true, '；': true, ';': true, '。': true}
)

func buildAestheticMirrorJobPrompt(ctx context.Context, user model.AuthUser, input AestheticMirrorJobCreateInput) string {
	fallbackPrompt := strings.TrimSpace(input.Prompt)
	template := strings.TrimSpace(input.PromptTemplate)
	if template == "" {
		return fallbackPrompt
	}

	parsedRules := parseAestheticMirrorReferenceRules(input.ExtraPrompt)
	basePrompt := buildAestheticMirrorFinalPrompt(buildAestheticMirrorBatchPromptTemplate(template), parsedRules.GlobalExtraPrompt)
	rule := parsedRules.Rules[input.Metadata.ReferenceIndex]
	analysis, err := analyzeAestheticMirrorReference(ctx, user, input)
	if err != nil {
		log.Printf("aesthetic mirror reference analysis skipped reference=%d group=%d err=%v", input.Metadata.ReferenceIndex, input.Metadata.GroupIndex, err)
		if fallbackPrompt != "" {
			return fallbackPrompt
		}
		return buildAestheticMirrorTaskPrompt(basePrompt, input.Metadata.ReferenceIndex, input.Metadata.GroupIndex, rule, nil)
	}

	prompt := buildAestheticMirrorTaskPrompt(basePrompt, input.Metadata.ReferenceIndex, input.Metadata.GroupIndex, rule, analysis)
	if strings.TrimSpace(prompt) != "" {
		return prompt
	}
	return fallbackPrompt
}

func analyzeAestheticMirrorReference(ctx context.Context, user model.AuthUser, input AestheticMirrorJobCreateInput) (*aestheticMirrorReferenceAnalysis, error) {
	modelName := resolveAestheticMirrorAnalysisModel()
	if modelName == "" {
		return nil, errors.New("未找到可用文本模型")
	}
	channel, err := SelectModelChannelForModel(modelName, "")
	if err != nil {
		return nil, err
	}

	content := []map[string]any{
		{
			"type": "text",
			"text": aestheticMirrorAnalysisPrompt(input.Metadata.ReferenceIndex, input.Metadata.GroupIndex),
		},
	}

	referenceDataURL, err := resolveAestheticMirrorImageDataURL(ctx, user, input.ReferenceImage, true)
	if err != nil {
		return nil, err
	}
	content = append(content,
		map[string]any{"type": "text", "text": "第 1 张图片是当前参考设计图。"},
		map[string]any{"type": "image_url", "image_url": map[string]string{"url": referenceDataURL}},
	)

	if len(input.ProductImages) > 0 {
		content = append(content, map[string]any{"type": "text", "text": "后续图片是产品素材图，只用于理解真实产品外观和包装，不用于改变参考图版式判断。"})
	}
	for index, image := range input.ProductImages {
		if index >= 2 {
			break
		}
		productDataURL, err := resolveAestheticMirrorImageDataURL(ctx, user, image, false)
		if err != nil {
			return nil, err
		}
		content = append(content, map[string]any{"type": "image_url", "image_url": map[string]string{"url": productDataURL}})
	}

	body, _ := json.Marshal(map[string]any{
		"model":       modelName,
		"temperature": 0,
		"messages": []map[string]any{
			{
				"role":    "system",
				"content": "You analyze ecommerce ad layouts and return strict JSON only. Do not generate the final image. Do not copy brand names or ad copy.",
			},
			{
				"role":    "user",
				"content": content,
			},
		},
	})

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, BuildModelChannelURL(channel, "/chat/completions"), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	request.Header.Set("Content-Type", "application/json")

	response, err := HTTPClientForChannel(channel).Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode >= http.StatusBadRequest {
		return nil, readAdminChannelError(responseBody, response.StatusCode, "爆款复刻参考图分析失败")
	}

	return parseAestheticMirrorReferenceAnalysis(extractChatCompletionContent(responseBody))
}

func resolveAestheticMirrorAnalysisModel() string {
	settings, err := repository.GetSettings()
	if err != nil {
		return ""
	}
	normalized := normalizeSettings(settings)
	candidates := []string{
		normalized.Public.ModelChannel.DefaultTextModel,
		normalized.Public.ModelChannel.DefaultModel,
	}
	candidates = append(candidates, normalized.Public.ModelChannel.AvailableModels...)
	candidates = append(candidates, collectChannelModels(normalized.Private.Channels)...)
	for _, candidate := range candidates {
		trimmed := strings.TrimSpace(candidate)
		if !isAestheticMirrorAnalysisModel(trimmed) {
			continue
		}
		if _, err := SelectModelChannelForModel(trimmed, ""); err == nil {
			return trimmed
		}
	}
	return ""
}

func isAestheticMirrorAnalysisModel(modelName string) bool {
	name := strings.ToLower(strings.TrimSpace(modelName))
	if name == "" {
		return false
	}
	if strings.Contains(name, "image") || strings.Contains(name, "dall-e") || strings.Contains(name, "grok-imagine") || strings.Contains(name, "video") {
		return false
	}
	return true
}

func resolveAestheticMirrorImageDataURL(ctx context.Context, user model.AuthUser, input AestheticMirrorJobImageInput, isReference bool) (string, error) {
	data, _, mimeType, err := resolveAestheticMirrorJobImage(ctx, user, input, isReference)
	if err != nil {
		return "", err
	}
	return "data:" + firstNonEmptyString(strings.TrimSpace(mimeType), "image/png") + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

func aestheticMirrorAnalysisPrompt(referenceIndex int, groupIndex int) string {
	return fmt.Sprintf(`请分析当前这组电商设计图任务，只做版式判断，不要生成图片。

任务信息：
- 当前参考图序号：%d
- 当前生成组序号：%d

判断目标：
1. layout_type 只能从以下枚举中选择一个：
   - product_hero
   - symptom_grid
   - doctor_endorsement
   - mechanism
   - data_proof
   - comparison
2. product_presence 只能从以下枚举中选择一个：
   - required：参考图明显以产品主视觉为核心，产品应该作为主要主体
   - optional：参考图更偏信息说明，产品可出现也可不出现
   - forbidden：参考图结构天然不需要产品，强行放产品会破坏版式
3. summary：一句中文短句，描述这张参考图的核心结构，不超过 40 个字
4. key_elements：最多 6 个中文短语，描述需要保留的版式元素，例如 主标题、卖点列表、医生人物、症状拼图、数据表、证书区、气泡背景

判断规则：
- 只看视觉结构、构图方式、信息分区和版式重心。
- 不要抄品牌名、产品名、原文案、数字和专属图形。
- 如果参考图本质是单品海报、主图、单瓶主视觉，layout_type 选 product_hero，product_presence 选 required。
- 如果参考图本质是医生背书、症状拼图、原理说明、数据证明、前后对比等信息型版式，优先选对应类型，product_presence 通常为 optional。
- 只有当参考图明显不需要产品，或者加入产品会明显破坏原版结构时，才返回 forbidden。

只返回 JSON，不要返回解释文字：
{
  "layout_type": "product_hero",
  "product_presence": "required",
  "summary": "蓝白医疗感单品主视觉海报",
  "key_elements": ["大标题", "单瓶主体", "卖点列表"]
}`, referenceIndex+1, groupIndex+1)
}

func parseAestheticMirrorReferenceAnalysis(content string) (*aestheticMirrorReferenceAnalysis, error) {
	jsonContent := extractJSONObject(content)
	if jsonContent == "" {
		return nil, errors.New("参考图分析没有返回有效 JSON")
	}

	var payload struct {
		LayoutType      string   `json:"layout_type"`
		ProductPresence string   `json:"product_presence"`
		Summary         string   `json:"summary"`
		KeyElements     []string `json:"key_elements"`
	}
	if err := json.Unmarshal([]byte(jsonContent), &payload); err != nil {
		return nil, err
	}

	analysis := &aestheticMirrorReferenceAnalysis{
		LayoutType:      normalizeAestheticMirrorLayoutType(payload.LayoutType),
		ProductPresence: normalizeAestheticMirrorProductPresence(payload.ProductPresence),
		Summary:         limitAestheticMirrorText(strings.TrimSpace(payload.Summary), 40),
		KeyElements:     normalizeAestheticMirrorKeyElements(payload.KeyElements),
	}
	if analysis.LayoutType == "" && analysis.ProductPresence == "" && analysis.Summary == "" && len(analysis.KeyElements) == 0 {
		return nil, errors.New("参考图分析结果为空")
	}
	return analysis, nil
}

func normalizeAestheticMirrorLayoutType(value string) aestheticMirrorLayoutType {
	switch strings.TrimSpace(value) {
	case string(aestheticMirrorProductHeroLayout):
		return aestheticMirrorProductHeroLayout
	case string(aestheticMirrorSymptomGridLayout):
		return aestheticMirrorSymptomGridLayout
	case string(aestheticMirrorDoctorEndorsementLayout):
		return aestheticMirrorDoctorEndorsementLayout
	case string(aestheticMirrorMechanismLayout):
		return aestheticMirrorMechanismLayout
	case string(aestheticMirrorDataProofLayout):
		return aestheticMirrorDataProofLayout
	case string(aestheticMirrorComparisonLayout):
		return aestheticMirrorComparisonLayout
	default:
		return ""
	}
}

func normalizeAestheticMirrorProductPresence(value string) aestheticMirrorProductPresence {
	switch strings.TrimSpace(value) {
	case string(aestheticMirrorProductRequired):
		return aestheticMirrorProductRequired
	case string(aestheticMirrorProductOptional):
		return aestheticMirrorProductOptional
	case string(aestheticMirrorProductForbidden):
		return aestheticMirrorProductForbidden
	default:
		return ""
	}
}

func normalizeAestheticMirrorKeyElements(values []string) []string {
	result := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		trimmed := limitAestheticMirrorText(strings.TrimSpace(value), 18)
		if trimmed == "" || seen[trimmed] {
			continue
		}
		seen[trimmed] = true
		result = append(result, trimmed)
		if len(result) >= 6 {
			break
		}
	}
	return result
}

func limitAestheticMirrorText(value string, maxRunes int) string {
	if maxRunes <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= maxRunes {
		return value
	}
	return string(runes[:maxRunes])
}

func parseAestheticMirrorReferenceRules(extraPrompt string) aestheticMirrorParsedRules {
	rules := map[int]aestheticMirrorReferenceRule{}
	globalSegments := []string{}
	segments := splitAestheticMirrorPromptSegments(extraPrompt)

	for _, segment := range segments {
		indexes := extractAestheticMirrorReferenceIndexes(segment)
		if len(indexes) == 0 {
			globalSegments = append(globalSegments, segment)
			continue
		}

		matched := false
		noProductMatched := aestheticMirrorNoProductPattern.MatchString(segment)
		if noProductMatched {
			for _, index := range indexes {
				mergeAestheticMirrorReferenceRule(rules, index, aestheticMirrorReferenceRule{ProductPresence: aestheticMirrorProductForbidden})
			}
			matched = true
		}
		if !noProductMatched && aestheticMirrorNeedProductPattern.MatchString(segment) {
			for _, index := range indexes {
				mergeAestheticMirrorReferenceRule(rules, index, aestheticMirrorReferenceRule{ProductPresence: aestheticMirrorProductRequired})
			}
			matched = true
		}

		layoutType := inferAestheticMirrorLayoutType(segment)
		if layoutType != "" {
			for _, index := range indexes {
				current := rules[index]
				productPresence := current.ProductPresence
				if productPresence == "" {
					if layoutType == aestheticMirrorProductHeroLayout {
						productPresence = aestheticMirrorProductRequired
					} else {
						productPresence = aestheticMirrorProductOptional
					}
				}
				mergeAestheticMirrorReferenceRule(rules, index, aestheticMirrorReferenceRule{
					LayoutType:      layoutType,
					ProductPresence: productPresence,
				})
			}
			matched = true
		}

		if !matched {
			globalSegments = append(globalSegments, segment)
			continue
		}

		if residual := cleanAestheticMirrorRuleSegment(segment); residual != "" {
			globalSegments = append(globalSegments, residual)
		}
	}

	return aestheticMirrorParsedRules{
		GlobalExtraPrompt: strings.TrimSpace(strings.Join(globalSegments, "\n")),
		Rules:             rules,
	}
}

func splitAestheticMirrorPromptSegments(extraPrompt string) []string {
	rawSegments := strings.FieldsFunc(extraPrompt, func(r rune) bool { return aestheticMirrorSplitRunes[r] })
	result := make([]string, 0, len(rawSegments))
	for _, segment := range rawSegments {
		trimmed := strings.TrimSpace(segment)
		if trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func extractAestheticMirrorReferenceIndexes(segment string) []int {
	match := aestheticMirrorReferenceIndexesPattern.FindStringSubmatch(segment)
	if len(match) < 2 {
		return nil
	}
	parts := strings.NewReplacer("及", "/", "和", "/").Replace(match[1])
	fields := strings.FieldsFunc(parts, func(r rune) bool {
		return r == '/' || r == '、' || r == ',' || r == '，' || r == ' '
	})
	result := []int{}
	seen := map[int]bool{}
	for _, field := range fields {
		value, err := strconv.Atoi(strings.TrimSpace(field))
		if err != nil || value <= 0 {
			continue
		}
		index := value - 1
		if !seen[index] {
			seen[index] = true
			result = append(result, index)
		}
	}
	return result
}

func mergeAestheticMirrorReferenceRule(rules map[int]aestheticMirrorReferenceRule, referenceIndex int, patch aestheticMirrorReferenceRule) {
	current := rules[referenceIndex]
	if patch.ProductPresence != "" {
		current.ProductPresence = patch.ProductPresence
	}
	if patch.LayoutType != "" {
		current.LayoutType = patch.LayoutType
	}
	rules[referenceIndex] = current
}

func inferAestheticMirrorLayoutType(segment string) aestheticMirrorLayoutType {
	switch {
	case aestheticMirrorDoctorPattern.MatchString(segment):
		return aestheticMirrorDoctorEndorsementLayout
	case aestheticMirrorSymptomPattern.MatchString(segment):
		return aestheticMirrorSymptomGridLayout
	case aestheticMirrorMechanismPattern.MatchString(segment):
		return aestheticMirrorMechanismLayout
	case aestheticMirrorDataProofPattern.MatchString(segment):
		return aestheticMirrorDataProofLayout
	case aestheticMirrorComparisonPattern.MatchString(segment):
		return aestheticMirrorComparisonLayout
	case aestheticMirrorProductHeroPattern.MatchString(segment):
		return aestheticMirrorProductHeroLayout
	default:
		return ""
	}
}

func cleanAestheticMirrorRuleSegment(segment string) string {
	cleaned := aestheticMirrorReferenceIndexesPattern.ReplaceAllString(segment, " ")
	cleaned = aestheticMirrorNoProductPattern.ReplaceAllString(cleaned, " ")
	cleaned = aestheticMirrorNeedProductPattern.ReplaceAllString(cleaned, " ")
	cleaned = aestheticMirrorLayoutCleanupPattern.ReplaceAllString(cleaned, " ")
	cleaned = strings.TrimSpace(cleaned)
	cleaned = strings.Trim(cleaned, "，,、/ ")
	return strings.Join(strings.Fields(cleaned), " ")
}

func buildAestheticMirrorBatchPromptTemplate(promptTemplate string) string {
	template := strings.TrimSpace(promptTemplate)
	if template == "" {
		return ""
	}
	batchAwareProductRule := "产品素材图里的产品需要严格保持真实外观、瓶型轮廓、颜色、透明液体质感、瓶盖、标签结构、品牌标识和可见细节，不要重绘成新产品，不要替换包装，不要伪造新品牌或新标签。是否让产品作为主视觉，优先由当前参考图的版式类型和任务要求决定：如果当前参考图是产品主视觉、卖点海报或主图，产品应作为主要主体；如果当前参考图是医生背书、症状拼图、成分机理、数据证明、对比说明等信息型版式，可以不出现产品，或仅保留极小的辅助产品元素，不要强行改成统一的居中单瓶海报。"
	strictProductRule := "产品素材图里的产品必须作为唯一产品主体，严格保持产品的瓶型轮廓、颜色、透明液体质感、瓶盖、标签结构、品牌标识和可见细节，不要重绘成新产品，不要替换包装，不要伪造新品牌或新标签。"
	if strings.Contains(template, strictProductRule) {
		return strings.Replace(template, strictProductRule, batchAwareProductRule, 1)
	}
	return template + "\n\n" + batchAwareProductRule
}

func buildAestheticMirrorFinalPrompt(promptTemplate string, extraPrompt string) string {
	parts := []string{}
	if trimmed := strings.TrimSpace(promptTemplate); trimmed != "" {
		parts = append(parts, trimmed)
	}
	if trimmed := strings.TrimSpace(extraPrompt); trimmed != "" {
		parts = append(parts, trimmed)
	}
	return strings.Join(parts, "\n\n")
}

func buildAestheticMirrorTaskPrompt(basePrompt string, referenceIndex int, groupIndex int, rule aestheticMirrorReferenceRule, analysis *aestheticMirrorReferenceAnalysis) string {
	resolvedLayoutType := rule.LayoutType
	if resolvedLayoutType == "" && analysis != nil {
		resolvedLayoutType = analysis.LayoutType
	}

	resolvedProductPresence := rule.ProductPresence
	if resolvedProductPresence == "" && analysis != nil {
		resolvedProductPresence = analysis.ProductPresence
	}
	if resolvedProductPresence == "" {
		if resolvedLayoutType == aestheticMirrorProductHeroLayout {
			resolvedProductPresence = aestheticMirrorProductRequired
		} else if resolvedLayoutType != "" {
			resolvedProductPresence = aestheticMirrorProductOptional
		}
	}

	parts := []string{strings.TrimSpace(basePrompt)}
	parts = append(parts, fmt.Sprintf("当前任务只对应参考图 %d，当前生成第 %d 组。参考图只用于学习视觉风格、信息层级、背景氛围、构图逻辑和卖点组织，不要融合其他参考图。不要把参考图当作可直接照抄的模板。", referenceIndex+1, groupIndex+1))
	if analysis != nil {
		if analysis.Summary != "" {
			parts = append(parts, "参考图结构摘要："+analysis.Summary)
		}
		if len(analysis.KeyElements) > 0 {
			parts = append(parts, "当前参考图可迁移的视觉元素："+strings.Join(analysis.KeyElements, "、")+"。这些元素只作为风格和信息组织参考，需要重新组合，不要逐区块照搬。")
		}
	}
	parts = append(parts, "优先迁移当前参考图自身的版式类型，但必须重构画面细节：标题位置、分栏比例、卡片数量、图标样式、人物姿态、证书/报告摆放需要有明显变化，避免生成和参考图几乎一模一样的版面。")
	parts = append(parts, "参考图中的人物、医生、证书、报告、机构标识、品牌名、标题文案和数据只能作为类型参考，必须重新生成不同的人物形象、不同的报告卡片和不同的信息排布，不得复制原图中的人物脸、姿势、证书截图、品牌或专属文字。")
	parts = append(parts, "如果参考图是产品主视觉，就突出产品但重构构图；如果是医生背书、症状拼图、成分机理、数据证明或对比说明这类信息型版式，就优先保留信息表达方式，不要为了塞入产品而统一改成居中单瓶海报。")

	switch resolvedProductPresence {
	case aestheticMirrorProductForbidden:
		parts = append(parts, "本任务明确要求不需要出现产品。允许完全不放产品，不要在画面中央放单瓶，不要为了塞入产品打乱原有的信息分区和版式结构。")
	case aestheticMirrorProductRequired:
		parts = append(parts, "本任务明确要求必须出现产品，产品应作为主视觉或主要信息锚点，且必须保持真实外观、包装、标签和品牌细节。")
	case aestheticMirrorProductOptional:
		parts = append(parts, "本任务可以不出现产品，也可以只保留极小的辅助产品元素。是否出现产品，以当前参考图的信息结构和表达目标优先。")
	}

	switch resolvedLayoutType {
	case aestheticMirrorDoctorEndorsementLayout:
		parts = append(parts, "版式重点放在医生或专家背书、权威感、可信度和医疗信息层级，可以以人物、证书、背书文案和信任元素为主。")
	case aestheticMirrorSymptomGridLayout:
		parts = append(parts, "版式重点做成症状拼图或问题说明图，允许多宫格、多分区、症状示意、痛点说明和信息清单，信息密度可以更高。")
	case aestheticMirrorMechanismLayout:
		parts = append(parts, "版式重点做成成分机理或作用原理说明图，突出结构化说明、图标、路径、机制解释和科普信息。")
	case aestheticMirrorDataProofLayout:
		parts = append(parts, "版式重点做成数据证明或检测认证图，突出图表、数据、证书、实验结果、检测说明和可信证据表达。")
	case aestheticMirrorComparisonLayout:
		parts = append(parts, "版式重点做成前后对比或对照说明图，强调差异对比、结果对照、分栏信息和可读性。")
	case aestheticMirrorProductHeroLayout:
		parts = append(parts, "版式重点做成产品主视觉海报，突出产品主体、核心卖点、品牌识别和电商投流主图感。")
	}

	filtered := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			filtered = append(filtered, trimmed)
		}
	}
	return strings.Join(filtered, "\n\n")
}

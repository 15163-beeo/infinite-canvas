package service

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
)

var (
	layerImageWarmupOnce sync.Once
	layerImageWorkerInst = &layerImageWorker{}
)

type layerImageWorker struct {
	mu     sync.Mutex
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
	stderr *lockedBuffer
}

type layerImageWorkerRequest struct {
	Input            string              `json:"input"`
	BackgroundOutput string              `json:"background_output"`
	ProductOutput    string              `json:"product_output"`
	MetaOutput       string              `json:"meta_output"`
	FocusBox         *layerImageFocusBox `json:"focus_box,omitempty"`
}

type layerImageWorkerResponse struct {
	Ready bool   `json:"ready,omitempty"`
	OK    bool   `json:"ok,omitempty"`
	Error string `json:"error,omitempty"`
}

type LayerImageResult struct {
	Background     []byte
	Product        []byte
	TextLayers     []LayerImageTextLayer
	OriginalWidth  int
	OriginalHeight int
	ProductOffsetX int
	ProductOffsetY int
	ProductWidth   int
	ProductHeight  int
}

type LayerImageOptions struct {
	ChannelMode   string
	Model         string
	TextModel     string
	ChannelID     string
	TextChannelID string
	BaseURL       string
	APIKey        string
	TextBaseURL   string
	TextAPIKey    string
}

type LayerImageTextLayer struct {
	Text        string             `json:"text"`
	Position    LayerImagePosition `json:"position"`
	Size        LayerImageSize     `json:"size"`
	FontFamily  string             `json:"fontFamily,omitempty"`
	FontWeight  string             `json:"fontWeight,omitempty"`
	FontStyle   string             `json:"fontStyle,omitempty"`
	FontSize    float64            `json:"fontSize,omitempty"`
	Color       string             `json:"color,omitempty"`
	StrokeColor string             `json:"strokeColor,omitempty"`
	StrokeWidth float64            `json:"strokeWidth,omitempty"`
	Rotation    float64            `json:"rotation,omitempty"`
	Opacity     float64            `json:"opacity,omitempty"`
}

type LayerImagePosition struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type LayerImageSize struct {
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type layerImageMeta struct {
	OriginalWidth  int                   `json:"original_width"`
	OriginalHeight int                   `json:"original_height"`
	ProductOffsetX int                   `json:"product_offset_x"`
	ProductOffsetY int                   `json:"product_offset_y"`
	ProductWidth   int                   `json:"product_width"`
	ProductHeight  int                   `json:"product_height"`
	TextLayers     []LayerImageTextLayer `json:"text_layers"`
}

type layerImageFocusBox struct {
	Left   int `json:"left"`
	Top    int `json:"top"`
	Right  int `json:"right"`
	Bottom int `json:"bottom"`
}

func StartLayerImageWarmup() {
	layerImageWarmupOnce.Do(func() {
		go func() {
			timeout := time.Duration(max(5, config.Cfg.RemoveBGTimeout)) * time.Second
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			defer cancel()
			if _, err := ensureLayerImageWorker(ctx); err != nil {
				log.Printf("layer image warmup failed: %v", err)
			}
		}()
	})
}

func LayerImage(ctx context.Context, filename string, contentType string, data []byte, options ...LayerImageOptions) (*LayerImageResult, error) {
	if len(data) == 0 {
		return nil, safeMessageError{message: "分层图片不能为空"}
	}
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(contentType)), "image/") {
		return nil, safeMessageError{message: "智能分层只支持图片文件"}
	}

	var background []byte
	var product []byte
	var meta layerImageMeta

	if aliyunImageSegConfigured() {
		if aliyunResult, err := layerImageWithAliyunImageSeg(ctx, filename, contentType, data, options...); err != nil {
			log.Printf("aliyun imageseg layer image failed, fallback: %v", err)
		} else {
			background = aliyunResult.Background
			product = aliyunResult.Product
			meta = layerImageMeta{
				OriginalWidth:  aliyunResult.OriginalWidth,
				OriginalHeight: aliyunResult.OriginalHeight,
				ProductOffsetX: aliyunResult.ProductOffsetX,
				ProductOffsetY: aliyunResult.ProductOffsetY,
				ProductWidth:   aliyunResult.ProductWidth,
				ProductHeight:  aliyunResult.ProductHeight,
			}
		}
	}

	if len(background) == 0 || len(product) == 0 {
		var err error
		background, product, meta, err = layerImageWithLocalProcess(ctx, filename, contentType, data, options...)
		if err != nil {
			return nil, err
		}
	}

	textLayers := meta.TextLayers
	if len(textLayers) == 0 {
		if aliyunOCRConfigured() {
			if ocrTextLayers, err := detectLayerImageTextLayersWithAliyunOCR(ctx, data, meta); err != nil {
				log.Printf("aliyun ocr layer text detection skipped: %v", err)
			} else if len(ocrTextLayers) > 0 {
				textLayers = ocrTextLayers
			}
		}
	}
	if len(options) > 0 {
		if modelTextLayers, err := detectLayerImageTextLayers(ctx, data, contentType, meta, options[0]); err != nil {
			log.Printf("layer image text detection skipped: %v", err)
		} else if len(modelTextLayers) > 0 {
			textLayers = mergeLayerImageTextLayers(textLayers, modelTextLayers, meta)
		}
	}

	maskTextLayers := textLayers
	editableTextLayers := filterEditableLayerImageTextLayers(textLayers, meta)

	backgroundInpainted := false
	if len(options) > 0 && strings.TrimSpace(options[0].Model) != "" {
		if inpaintedBackground, err := refineLayerImageBackgroundWithImageModel(ctx, filename, contentType, data, product, meta, maskTextLayers, options[0]); err != nil {
			log.Printf("layer image GPT background inpaint skipped: %v", err)
		} else {
			background = inpaintedBackground
			backgroundInpainted = true
		}
	}
	if len(maskTextLayers) > 0 && !backgroundInpainted {
		if cleanedBackground, err := removeTextLayersFromBackground(background, maskTextLayers); err != nil {
			log.Printf("layer image background text cleanup skipped: %v", err)
		} else {
			background = cleanedBackground
		}
	}

	return &LayerImageResult{
		Background:     background,
		Product:        product,
		TextLayers:     editableTextLayers,
		OriginalWidth:  meta.OriginalWidth,
		OriginalHeight: meta.OriginalHeight,
		ProductOffsetX: meta.ProductOffsetX,
		ProductOffsetY: meta.ProductOffsetY,
		ProductWidth:   meta.ProductWidth,
		ProductHeight:  meta.ProductHeight,
	}, nil
}

func filterEditableLayerImageTextLayers(layers []LayerImageTextLayer, meta layerImageMeta) []LayerImageTextLayer {
	if len(layers) == 0 {
		return layers
	}
	filtered := make([]LayerImageTextLayer, 0, len(layers))
	for _, layer := range layers {
		if !hasReadableTextRune(layer.Text) {
			continue
		}
		if shouldSkipDecorativeBadgeTextLayer(layer, meta) {
			continue
		}
		filtered = append(filtered, layer)
	}
	return filtered
}

func shouldSkipDecorativeBadgeTextLayer(layer LayerImageTextLayer, meta layerImageMeta) bool {
	if meta.OriginalWidth <= 0 || meta.OriginalHeight <= 0 || meta.ProductWidth <= 0 {
		return false
	}
	x := layer.Position.X
	y := layer.Position.Y
	width := math.Max(1, layer.Size.Width)
	height := math.Max(1, layer.Size.Height)
	centerX := x + width/2
	centerY := y + height/2
	leftBoundary := float64(meta.OriginalWidth) * 0.28
	rightBoundary := float64(meta.ProductOffsetX) - float64(meta.OriginalWidth)*0.02
	if rightBoundary <= leftBoundary {
		return false
	}
	inMiddleBadgeZone := centerX >= leftBoundary &&
		centerX <= rightBoundary &&
		centerY >= float64(meta.OriginalHeight)*0.48 &&
		centerY <= float64(meta.OriginalHeight)*0.82
	if !inMiddleBadgeZone {
		return false
	}
	compact := width <= float64(meta.OriginalWidth)*0.22 && height <= float64(meta.OriginalHeight)*0.09
	if !compact {
		return false
	}
	text := strings.TrimSpace(layer.Text)
	return len([]rune(text)) <= 12
}

func hasReadableTextRune(text string) bool {
	for _, value := range text {
		if unicode.IsLetter(value) || unicode.IsDigit(value) {
			return true
		}
	}
	return false
}

func mergeLayerImageTextLayers(primary []LayerImageTextLayer, supplemental []LayerImageTextLayer, meta layerImageMeta) []LayerImageTextLayer {
	if len(primary) == 0 {
		result := []LayerImageTextLayer{}
		for _, layer := range supplemental {
			result = append(result, splitLayerImageTextLayerLines(layer)...)
		}
		return result
	}
	result := append([]LayerImageTextLayer{}, primary...)
	for _, supplementalLayer := range supplemental {
		for _, candidate := range splitLayerImageTextLayerLines(supplementalLayer) {
			if strings.TrimSpace(candidate.Text) == "" || shouldSkipProductTextLayer(candidate.Position.X, candidate.Position.Y, candidate.Size.Width, candidate.Size.Height, meta) || shouldSkipDecorativeBadgeTextLayer(candidate, meta) {
				continue
			}
			matchIndex := -1
			bestOverlap := 0.0
			for index, existing := range result {
				overlap := layerImageTextOverlapRatio(existing, candidate)
				if overlap > bestOverlap {
					bestOverlap = overlap
					matchIndex = index
				}
			}
			if matchIndex >= 0 && bestOverlap > 0.25 {
				result[matchIndex] = mergeLayerImageTextLayer(result[matchIndex], candidate)
				continue
			}
			if !hasSimilarLayerImageText(result, candidate) {
				result = append(result, candidate)
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

func splitLayerImageTextLayerLines(layer LayerImageTextLayer) []LayerImageTextLayer {
	rawLines := strings.Split(strings.ReplaceAll(layer.Text, "\r\n", "\n"), "\n")
	lines := make([]string, 0, len(rawLines))
	for _, line := range rawLines {
		line = strings.TrimSpace(line)
		if line != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) <= 1 {
		layer.Text = strings.TrimSpace(layer.Text)
		return []LayerImageTextLayer{layer}
	}

	lineHeight := math.Max(1, layer.Size.Height/float64(len(lines)))
	result := make([]LayerImageTextLayer, 0, len(lines))
	for index, line := range lines {
		item := layer
		item.Text = line
		item.Position.Y = layer.Position.Y + lineHeight*float64(index)
		item.Size.Height = lineHeight
		if item.FontSize > lineHeight*0.9 || item.FontSize <= 0 {
			item.FontSize = math.Max(8, lineHeight*0.82)
		}
		result = append(result, item)
	}
	return result
}

func mergeLayerImageTextLayer(primary LayerImageTextLayer, supplemental LayerImageTextLayer) LayerImageTextLayer {
	primaryText := strings.TrimSpace(primary.Text)
	supplementalText := strings.TrimSpace(supplemental.Text)
	if supplementalText != "" && len([]rune(supplementalText)) > len([]rune(primaryText)) && strings.Contains(supplementalText, primaryText) {
		primary.Text = supplementalText
		if supplemental.Size.Width > primary.Size.Width*1.08 || supplemental.Size.Height > primary.Size.Height*1.08 {
			primary.Position = supplemental.Position
			primary.Size = supplemental.Size
			if supplemental.FontSize > 0 {
				primary.FontSize = supplemental.FontSize
			}
		}
	}
	return primary
}

func hasSimilarLayerImageText(layers []LayerImageTextLayer, candidate LayerImageTextLayer) bool {
	candidateText := strings.TrimSpace(candidate.Text)
	for _, layer := range layers {
		text := strings.TrimSpace(layer.Text)
		if text == candidateText || strings.Contains(text, candidateText) || strings.Contains(candidateText, text) {
			if layerImageTextOverlapRatio(layer, candidate) > 0.12 {
				return true
			}
		}
	}
	return false
}

func layerImageTextOverlapRatio(a LayerImageTextLayer, b LayerImageTextLayer) float64 {
	rectA := rectFloat{x: a.Position.X, y: a.Position.Y, w: math.Max(1, a.Size.Width), h: math.Max(1, a.Size.Height)}
	rectB := rectFloat{x: b.Position.X, y: b.Position.Y, w: math.Max(1, b.Size.Width), h: math.Max(1, b.Size.Height)}
	overlap := rectOverlapArea(rectA, rectB)
	if overlap <= 0 {
		return 0
	}
	return overlap / math.Min(math.Max(1, rectA.w*rectA.h), math.Max(1, rectB.w*rectB.h))
}

func layerImageWithLocalProcess(ctx context.Context, filename string, contentType string, data []byte, options ...LayerImageOptions) ([]byte, []byte, layerImageMeta, error) {
	inputFile, err := os.CreateTemp("", "layer-image-input-*"+imageExtByMime(contentType, filename))
	if err != nil {
		return nil, nil, layerImageMeta{}, err
	}
	inputPath := inputFile.Name()
	defer os.Remove(inputPath)
	if _, err := inputFile.Write(data); err != nil {
		_ = inputFile.Close()
		return nil, nil, layerImageMeta{}, err
	}
	if err := inputFile.Close(); err != nil {
		return nil, nil, layerImageMeta{}, err
	}

	backgroundFile, err := os.CreateTemp("", "layer-image-background-*.png")
	if err != nil {
		return nil, nil, layerImageMeta{}, err
	}
	backgroundPath := backgroundFile.Name()
	_ = backgroundFile.Close()
	defer os.Remove(backgroundPath)

	productFile, err := os.CreateTemp("", "layer-image-product-*.png")
	if err != nil {
		return nil, nil, layerImageMeta{}, err
	}
	productPath := productFile.Name()
	_ = productFile.Close()
	defer os.Remove(productPath)

	metaFile, err := os.CreateTemp("", "layer-image-meta-*.json")
	if err != nil {
		return nil, nil, layerImageMeta{}, err
	}
	metaPath := metaFile.Name()
	_ = metaFile.Close()
	defer os.Remove(metaPath)

	if err := runLayerImageProcess(ctx, inputPath, backgroundPath, productPath, metaPath, nil); err != nil {
		return nil, nil, layerImageMeta{}, err
	}

	background, product, meta, err := readLayerImageArtifacts(backgroundPath, productPath, metaPath)
	if err != nil {
		return nil, nil, layerImageMeta{}, err
	}

	if len(options) > 0 && shouldRefineLayerImageProduct(meta) {
		if focusBox, focusErr := detectLayerImageFocusBox(ctx, data, contentType, meta, options[0]); focusErr != nil {
			log.Printf("layer image focus detection skipped: %v", focusErr)
		} else if focusBox != nil {
			if rerunErr := runLayerImageProcess(ctx, inputPath, backgroundPath, productPath, metaPath, focusBox); rerunErr != nil {
				log.Printf("layer image focus refinement skipped: %v", rerunErr)
			} else if refinedBackground, refinedProduct, refinedMeta, readErr := readLayerImageArtifacts(backgroundPath, productPath, metaPath); readErr != nil {
				log.Printf("layer image refined artifacts ignored: %v", readErr)
			} else {
				background = refinedBackground
				product = refinedProduct
				meta = refinedMeta
			}
		}
	}

	return background, product, meta, nil
}

func runLayerImageProcess(ctx context.Context, inputPath string, backgroundPath string, productPath string, metaPath string, focusBox *layerImageFocusBox) error {
	if err := layerImageWithWorker(ctx, inputPath, backgroundPath, productPath, metaPath, focusBox); err != nil {
		log.Printf("layer image worker failed, fallback to one-shot command: %v", err)
		if fallbackErr := runLayerImageCommand(ctx, inputPath, backgroundPath, productPath, metaPath, focusBox); fallbackErr != nil {
			return fallbackErr
		}
	}
	return nil
}

func readLayerImageArtifacts(backgroundPath string, productPath string, metaPath string) ([]byte, []byte, layerImageMeta, error) {
	background, err := os.ReadFile(backgroundPath)
	if err != nil {
		return nil, nil, layerImageMeta{}, err
	}
	product, err := os.ReadFile(productPath)
	if err != nil {
		return nil, nil, layerImageMeta{}, err
	}
	if len(background) == 0 || len(product) == 0 {
		return nil, nil, layerImageMeta{}, safeMessageError{message: "智能分层结果为空"}
	}

	metaBytes, err := os.ReadFile(metaPath)
	if err != nil {
		return nil, nil, layerImageMeta{}, err
	}
	meta := layerImageMeta{}
	if err := json.Unmarshal(metaBytes, &meta); err != nil {
		return nil, nil, layerImageMeta{}, err
	}
	if meta.OriginalWidth <= 0 || meta.OriginalHeight <= 0 || meta.ProductWidth <= 0 || meta.ProductHeight <= 0 {
		return nil, nil, layerImageMeta{}, safeMessageError{message: "智能分层结果无效"}
	}
	return background, product, meta, nil
}

func detectLayerImageTextLayers(ctx context.Context, image []byte, contentType string, meta layerImageMeta, options LayerImageOptions) ([]LayerImageTextLayer, error) {
	modelName := strings.TrimSpace(firstNonEmpty(options.TextModel, options.Model))
	if modelName == "" {
		return nil, nil
	}
	channel, err := layerImageModelChannel(modelName, options)
	if err != nil {
		return nil, err
	}
	dataURL := "data:" + firstNonEmpty(contentType, "image/png") + ";base64," + base64.StdEncoding.EncodeToString(image)
	body, _ := json.Marshal(map[string]any{
		"model":       modelName,
		"temperature": 0,
		"messages": []map[string]any{
			{
				"role":    "system",
				"content": "You extract editable canvas text layers from images. Return only valid JSON. Do not invent text. Coordinates must be in original image pixels.",
			},
			{
				"role": "user",
				"content": []map[string]any{
					{
						"type": "text",
						"text": layerImageTextPrompt(meta),
					},
					{
						"type": "image_url",
						"image_url": map[string]any{
							"url": dataURL,
						},
					},
				},
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
		return nil, readAdminChannelError(responseBody, response.StatusCode, "智能分层文字识别失败")
	}
	content := extractChatCompletionContent(responseBody)
	if strings.TrimSpace(content) == "" {
		return nil, errors.New("智能分层文字识别结果为空")
	}
	return parseLayerImageTextLayers(content, meta)
}

func detectLayerImageFocusBox(ctx context.Context, image []byte, contentType string, meta layerImageMeta, options LayerImageOptions) (*layerImageFocusBox, error) {
	modelName := strings.TrimSpace(firstNonEmpty(options.TextModel, options.Model))
	if modelName == "" {
		return nil, nil
	}
	channel, err := layerImageModelChannel(modelName, options)
	if err != nil {
		return nil, err
	}
	dataURL := "data:" + firstNonEmpty(contentType, "image/png") + ";base64," + base64.StdEncoding.EncodeToString(image)
	body, _ := json.Marshal(map[string]any{
		"model":       modelName,
		"temperature": 0,
		"messages": []map[string]any{
			{
				"role":    "system",
				"content": "You locate the complete sellable product group in ad images. Include all physical product items that belong to the same packshot or product set, not just the largest package. Return only valid JSON. Coordinates must be in original image pixels.",
			},
			{
				"role": "user",
				"content": []map[string]any{
					{
						"type": "text",
						"text": layerImageFocusPrompt(meta),
					},
					{
						"type": "image_url",
						"image_url": map[string]any{
							"url": dataURL,
						},
					},
				},
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
		return nil, readAdminChannelError(responseBody, response.StatusCode, "智能分层主体识别失败")
	}
	content := extractChatCompletionContent(responseBody)
	if strings.TrimSpace(content) == "" {
		return nil, errors.New("智能分层主体识别结果为空")
	}
	return parseLayerImageFocusBox(content, meta)
}

func detectLayerImageFocusBoxForOriginal(ctx context.Context, imageData []byte, contentType string, options LayerImageOptions) (*layerImageFocusBox, error) {
	_, width, height := decodeNRGBAImage(imageData)
	if width <= 0 || height <= 0 {
		return nil, errors.New("原图解析失败")
	}
	return detectLayerImageFocusBox(ctx, imageData, contentType, layerImageMeta{
		OriginalWidth:  width,
		OriginalHeight: height,
	}, options)
}

func layerImageTextPrompt(meta layerImageMeta) string {
	return fmt.Sprintf(`请进行通用 OCR 文字识别，并把可编辑文字返回为画布文字层。

OCR 识别要求：
1. 只识别能准确确认的文字，保持原文语言、标点、大小写和自然阅读顺序。
2. 按图片中的文字行或自然段落输出，不要猜测、不要补全。
3. 如果某一整段或整行文字模糊、遮挡、过曝、变形、缺字严重，或无法可靠判断，请直接省略这一整段或整行。
4. 不要用问号、星号、省略号或占位符表示不确定文字。
5. 如果图片中没有可准确识别的文字，返回空结果。
6. 不要识别水印。
7. 不要识别物体上的文字。

请只返回以下 JSON，不要返回解释文字：
{
  "text_layers": [
    {
      "text": "准确识别出的可编辑文字",
      "position": {"x": 0, "y": 0},
      "size": {"width": 0, "height": 0},
      "fontFamily": "sans-serif",
      "fontWeight": "normal",
      "fontStyle": "normal",
      "fontSize": 24,
      "color": "#111111",
      "rotation": 0,
      "opacity": 1
    }
  ]
}

文字层规则：
- 使用原图像素坐标。图片尺寸是 %dx%d。
- position 是文字框左上角坐标。
- size 是文字框宽高，单位像素；无法判断时可填 0。
- fontSize、color、rotation、opacity 尽量按图片估计。
- 忽略装饰图形、图标、产品形状和背景纹理。
- 不返回被主体/产品遮挡的文字。
- 如果没有可准确识别的文字，返回 {"text_layers":[]}。`, meta.OriginalWidth, meta.OriginalHeight)
}

func layerImageFocusPrompt(meta layerImageMeta) string {
	return fmt.Sprintf(`请识别这张图片里完整的可售商品主体组，只框出同一套主视觉 packshot 中真实存在的商品实体。这个规则适用于所有电商广告图，不要根据商品品类做特殊处理。

需要包含的主体范围：
1. 主包装盒、瓶、袋、罐、支、片、盒内露出的同款商品。
2. 靠在主包装前侧、侧边、底部，或与主包装接触/重叠/紧贴陈列的试用装、单支样品、演示条、小包装，只要它明显属于同一套商品组，就必须包含。
3. 与包装物理连接、贴在包装角落、作为包装一部分展示的吊牌、认证角标、封贴、包装折页，可以包含。
4. 插在包装里、露出在包装上方、被主包装局部遮挡但仍属于同一商品陈列的实物，也必须包含。

不要包含以下内容：
1. 大标题、卖点文案、角标、价格条、按钮、徽章、活动标签。
2. 背景纹理、装饰线条、图标、网格、阴影。
3. 与主体明显分离的说明区域或文案区域。
4. 功能点列表、底部横幅、圆形说明牌、没有与商品接触的漂浮促销物、插画或道具。

识别规则：
1. 如果多个商品实体属于同一套主商品组，返回一个能包住整组商品的总框，不要只框最大那一个盒子。
2. 框要贴近整组商品的可见边缘，但不要裁掉前景单支、侧边小样或顶部露出的同款商品。
3. 如果某个细长单支/试用装与主包装贴靠、重叠、插在包装里，默认它属于主体组，应该包含。
4. 只有当某个小物件与主商品组明显分离、没有接触关系、只是独立装饰或赠品时，才排除它。
5. 不要把大字文案、底部横幅文案、圆形说明牌、价格块、按钮、卖点图标算进主体框。
6. 如果无法可靠判断，返回 {"subject_box": null}。

请只返回以下 JSON，不要返回解释：
{
  "subject_box": {"left": 0, "top": 0, "right": 0, "bottom": 0}
}

图片尺寸是 %dx%d，坐标必须使用原图像素坐标。`, meta.OriginalWidth, meta.OriginalHeight)
}

func layerImageModelChannel(modelName string, options LayerImageOptions) (model.ModelChannel, error) {
	channelMode := strings.ToLower(strings.TrimSpace(options.ChannelMode))
	if channelMode == "local" {
		baseURL := strings.TrimSpace(firstNonEmpty(options.TextBaseURL, options.BaseURL))
		apiKey := strings.TrimSpace(firstNonEmpty(options.TextAPIKey, options.APIKey))
		channel := normalizeModelChannel(model.ModelChannel{
			ID:      strings.TrimSpace(firstNonEmpty(options.TextChannelID, options.ChannelID)),
			Name:    "用户本地直连",
			BaseURL: baseURL,
			APIKey:  apiKey,
			Models:  []string{modelName},
			Enabled: true,
		})
		if channel.BaseURL == "" {
			return model.ModelChannel{}, safeMessageError{message: "智能分层文字识别缺少本地接口地址"}
		}
		if channel.APIKey == "" {
			return model.ModelChannel{}, safeMessageError{message: "智能分层文字识别缺少 API Key"}
		}
		return channel, nil
	}
	return SelectModelChannelForModel(modelName, strings.TrimSpace(firstNonEmpty(options.TextChannelID, options.ChannelID)))
}

func parseLayerImageTextLayers(content string, meta layerImageMeta) ([]LayerImageTextLayer, error) {
	raw := extractLayerImageJSON(content)
	if raw == "" {
		return nil, errors.New("智能分层文字识别没有返回 JSON")
	}
	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil, err
	}
	items := []any{}
	switch value := decoded.(type) {
	case []any:
		items = value
	case map[string]any:
		if list, ok := value["text_layers"].([]any); ok {
			items = list
		} else if list, ok := value["textLayers"].([]any); ok {
			items = list
		}
	}
	result := make([]LayerImageTextLayer, 0, len(items))
	for _, item := range items {
		record, ok := item.(map[string]any)
		if !ok {
			continue
		}
		layer := normalizeLayerImageTextLayer(record, meta)
		if strings.TrimSpace(layer.Text) == "" {
			continue
		}
		result = append(result, layer)
		if len(result) >= 40 {
			break
		}
	}
	return result, nil
}

func parseLayerImageFocusBox(content string, meta layerImageMeta) (*layerImageFocusBox, error) {
	raw := extractLayerImageJSON(content)
	if raw == "" {
		return nil, errors.New("智能分层主体识别没有返回 JSON")
	}
	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil, err
	}
	record, ok := decoded.(map[string]any)
	if !ok {
		return nil, errors.New("智能分层主体识别结果格式无效")
	}

	if value, exists := record["subject_box"]; exists && value == nil {
		return nil, nil
	}

	candidate := mapField(record, "subject_box")
	if candidate == nil {
		candidate = mapField(record, "product_box")
	}
	if candidate == nil {
		candidate = mapField(record, "bbox")
	}
	if candidate == nil {
		candidate = mapField(record, "box")
	}
	if candidate == nil {
		candidate = record
	}
	box := normalizeLayerImageFocusBox(candidate, meta)
	if box == nil {
		return nil, nil
	}
	return box, nil
}

func extractLayerImageJSON(content string) string {
	cleaned := strings.TrimSpace(content)
	if object := extractJSONObject(cleaned); object != "" {
		return object
	}
	start := strings.Index(cleaned, "[")
	end := strings.LastIndex(cleaned, "]")
	if start >= 0 && end > start {
		return cleaned[start : end+1]
	}
	return ""
}

func normalizeLayerImageTextLayer(record map[string]any, meta layerImageMeta) LayerImageTextLayer {
	position := mapField(record, "position")
	if position == nil {
		position = record
	}
	size := mapField(record, "size")
	if size == nil {
		size = record
	}
	text := strings.TrimSpace(layerImageStringField(record, "text", "content"))
	width := clampFloat(numberField(size, "width", "w"), 1, float64(max(1, meta.OriginalWidth)))
	height := clampFloat(numberField(size, "height", "h"), 1, float64(max(1, meta.OriginalHeight)))
	fontSize := numberField(record, "fontSize", "font_size")
	if fontSize <= 0 {
		fontSize = math.Max(8, height*0.72)
	}
	color := strings.TrimSpace(layerImageStringField(record, "color", "fill"))
	if color == "" {
		color = "#111111"
	}
	return LayerImageTextLayer{
		Text: text,
		Position: LayerImagePosition{
			X: clampFloat(numberField(position, "x", "left"), 0, float64(max(1, meta.OriginalWidth))),
			Y: clampFloat(numberField(position, "y", "top"), 0, float64(max(1, meta.OriginalHeight))),
		},
		Size: LayerImageSize{
			Width:  width,
			Height: height,
		},
		FontFamily:  firstNonEmpty(layerImageStringField(record, "fontFamily", "font_family"), "sans-serif"),
		FontWeight:  firstNonEmpty(layerImageStringField(record, "fontWeight", "font_weight"), "normal"),
		FontStyle:   firstNonEmpty(layerImageStringField(record, "fontStyle", "font_style"), "normal"),
		FontSize:    clampFloat(fontSize, 1, float64(max(1, meta.OriginalHeight))),
		Color:       color,
		StrokeColor: layerImageStringField(record, "strokeColor", "stroke_color"),
		StrokeWidth: clampFloat(numberField(record, "strokeWidth", "stroke_width"), 0, float64(max(1, meta.OriginalHeight))),
		Rotation:    clampFloat(numberField(record, "rotation", "angle"), -360, 360),
		Opacity:     clampFloat(firstPositive(numberField(record, "opacity"), 1), 0, 1),
	}
}

func mapField(record map[string]any, key string) map[string]any {
	value, _ := record[key].(map[string]any)
	return value
}

func layerImageStringField(record map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := record[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func numberField(record map[string]any, keys ...string) float64 {
	for _, key := range keys {
		switch value := record[key].(type) {
		case float64:
			if !math.IsNaN(value) && !math.IsInf(value, 0) {
				return value
			}
		case int:
			return float64(value)
		case string:
			var number float64
			if _, err := fmt.Sscanf(strings.TrimSpace(value), "%f", &number); err == nil && !math.IsNaN(number) && !math.IsInf(number, 0) {
				return number
			}
		}
	}
	return 0
}

func clampFloat(value float64, minValue float64, maxValue float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return minValue
	}
	if value < minValue {
		return minValue
	}
	if value > maxValue {
		return maxValue
	}
	return value
}

func firstPositive(value float64, fallback float64) float64 {
	if value > 0 {
		return value
	}
	return fallback
}

func normalizeLayerImageFocusBox(record map[string]any, meta layerImageMeta) *layerImageFocusBox {
	left := int(math.Round(clampFloat(numberField(record, "left", "x", "x0", "minX"), 0, float64(max(1, meta.OriginalWidth)-1))))
	top := int(math.Round(clampFloat(numberField(record, "top", "y", "y0", "minY"), 0, float64(max(1, meta.OriginalHeight)-1))))
	right := int(math.Round(clampFloat(numberField(record, "right", "x1", "maxX"), float64(left+1), float64(max(1, meta.OriginalWidth)))))
	bottom := int(math.Round(clampFloat(numberField(record, "bottom", "y1", "maxY"), float64(top+1), float64(max(1, meta.OriginalHeight)))))
	if right-left < max(12, meta.OriginalWidth/30) || bottom-top < max(12, meta.OriginalHeight/30) {
		return nil
	}
	areaRatio := float64((right-left)*(bottom-top)) / float64(max(1, meta.OriginalWidth*meta.OriginalHeight))
	if areaRatio >= 0.92 {
		return nil
	}
	return &layerImageFocusBox{Left: left, Top: top, Right: right, Bottom: bottom}
}

func shouldRefineLayerImageProduct(meta layerImageMeta) bool {
	widthRatio := float64(meta.ProductWidth) / float64(max(1, meta.OriginalWidth))
	heightRatio := float64(meta.ProductHeight) / float64(max(1, meta.OriginalHeight))
	areaRatio := float64(meta.ProductWidth*meta.ProductHeight) / float64(max(1, meta.OriginalWidth*meta.OriginalHeight))
	leftRatio := float64(meta.ProductOffsetX) / float64(max(1, meta.OriginalWidth))
	return areaRatio > 0.46 || (widthRatio > 0.72 && leftRatio < 0.08) || (widthRatio > 0.84 && heightRatio > 0.4)
}

func layerImageWithWorker(ctx context.Context, inputPath string, backgroundPath string, productPath string, metaPath string, focusBox *layerImageFocusBox) error {
	worker, err := ensureLayerImageWorker(ctx)
	if err != nil {
		return err
	}
	return worker.process(ctx, inputPath, backgroundPath, productPath, metaPath, focusBox)
}

func ensureLayerImageWorker(ctx context.Context) (*layerImageWorker, error) {
	return layerImageWorkerInst.ensure(ctx)
}

func (worker *layerImageWorker) ensure(ctx context.Context) (*layerImageWorker, error) {
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

func (worker *layerImageWorker) startLocked(ctx context.Context) error {
	scriptPath, err := layerImageWorkerScriptPath()
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
	response, err := readLayerImageWorkerResponse(ctx, stdout)
	if err != nil {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		go func() { _ = cmd.Wait() }()
		return normalizeLayerImageFailure(err, []byte(stderr.String()))
	}
	if !response.Ready {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		go func() { _ = cmd.Wait() }()
		return normalizeLayerImageFailure(errors.New("智能分层 worker 未就绪"), []byte(response.Error+"\n"+stderr.String()))
	}

	worker.cmd = cmd
	worker.stdin = stdin
	worker.stdout = stdout
	worker.stderr = stderr

	go worker.watch(cmd)

	return nil
}

func (worker *layerImageWorker) watch(command *exec.Cmd) {
	if err := command.Wait(); err != nil {
		log.Printf("layer image worker exited: %v", err)
	}
	worker.mu.Lock()
	defer worker.mu.Unlock()
	if worker.cmd == command {
		worker.stdin = nil
		worker.stdout = nil
		worker.cmd = nil
	}
}

func (worker *layerImageWorker) process(ctx context.Context, inputPath string, backgroundPath string, productPath string, metaPath string, focusBox *layerImageFocusBox) error {
	worker.mu.Lock()
	defer worker.mu.Unlock()

	if worker.cmd == nil || worker.stdin == nil || worker.stdout == nil {
		return errors.New("智能分层 worker 未启动")
	}

	payload, err := json.Marshal(layerImageWorkerRequest{
		Input:            inputPath,
		BackgroundOutput: backgroundPath,
		ProductOutput:    productPath,
		MetaOutput:       metaPath,
		FocusBox:         focusBox,
	})
	if err != nil {
		return err
	}
	if _, err := worker.stdin.Write(append(payload, '\n')); err != nil {
		worker.closeLocked()
		return normalizeLayerImageFailure(err, []byte(worker.stderrStringLocked()))
	}

	response, err := readLayerImageWorkerResponse(ctx, worker.stdout)
	if err != nil {
		worker.closeLocked()
		return normalizeLayerImageFailure(err, []byte(worker.stderrStringLocked()))
	}
	if response.OK {
		return nil
	}

	errOutput := response.Error
	if stderr := worker.stderrStringLocked(); strings.TrimSpace(stderr) != "" {
		errOutput = strings.TrimSpace(strings.Join([]string{errOutput, stderr}, "\n"))
	}
	if errOutput == "" {
		errOutput = "智能分层 worker 返回异常"
	}
	return normalizeLayerImageFailure(errors.New(errOutput), []byte(errOutput))
}

func (worker *layerImageWorker) stderrStringLocked() string {
	if worker.stderr == nil {
		return ""
	}
	return worker.stderr.String()
}

func (worker *layerImageWorker) closeLocked() {
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

func readLayerImageWorkerResponse(ctx context.Context, reader *bufio.Reader) (layerImageWorkerResponse, error) {
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
		return layerImageWorkerResponse{}, ctx.Err()
	case result := <-resultCh:
		if result.err != nil {
			return layerImageWorkerResponse{}, result.err
		}
		line := bytes.TrimSpace(result.line)
		response := layerImageWorkerResponse{}
		if err := json.Unmarshal(line, &response); err != nil {
			return response, fmt.Errorf("智能分层 worker 响应解析失败: %w", err)
		}
		return response, nil
	}
}

func runLayerImageCommand(ctx context.Context, inputPath string, backgroundPath string, productPath string, metaPath string, focusBox *layerImageFocusBox) error {
	command, err := layerImageCommand(ctx, inputPath, backgroundPath, productPath, metaPath, focusBox)
	if err != nil {
		return err
	}
	output, err := command.CombinedOutput()
	if err != nil {
		return normalizeLayerImageFailure(err, output)
	}
	return nil
}

func layerImageCommand(ctx context.Context, inputPath string, backgroundPath string, productPath string, metaPath string, focusBox *layerImageFocusBox) (*exec.Cmd, error) {
	scriptPath, err := layerImageScriptPath()
	if err != nil {
		return nil, err
	}
	args := []string{
		scriptPath,
		"--model", strings.TrimSpace(config.Cfg.RemoveBGModel),
		"--input", inputPath,
		"--background-output", backgroundPath,
		"--product-output", productPath,
		"--meta-output", metaPath,
	}
	if focusBox != nil {
		args = append(
			args,
			"--focus-left", fmt.Sprint(focusBox.Left),
			"--focus-top", fmt.Sprint(focusBox.Top),
			"--focus-right", fmt.Sprint(focusBox.Right),
			"--focus-bottom", fmt.Sprint(focusBox.Bottom),
		)
	}
	cmd := exec.CommandContext(ctx, strings.TrimSpace(config.Cfg.RemoveBGPython), args...)
	cmd.Dir = projectRoot()
	cmd.Env = append(os.Environ(), "PYTHONPATH="+joinedPythonPath(resolveWorkspacePath(config.Cfg.RemoveBGPythonPath), os.Getenv("PYTHONPATH")))
	return cmd, nil
}

func layerImageScriptPath() (string, error) {
	path := resolveWorkspacePath("tools/layer_image.py")
	if _, err := os.Stat(path); err != nil {
		return "", fmt.Errorf("智能分层脚本不存在: %w", err)
	}
	return path, nil
}

func layerImageWorkerScriptPath() (string, error) {
	path := resolveWorkspacePath("tools/layer_image_worker.py")
	if _, err := os.Stat(path); err != nil {
		return "", fmt.Errorf("智能分层 worker 脚本不存在: %w", err)
	}
	return path, nil
}

func normalizeLayerImageFailure(commandErr error, output []byte) error {
	message := strings.TrimSpace(string(output))
	switch {
	case strings.Contains(message, "No module named 'rembg'"),
		strings.Contains(message, "No module named rembg"),
		strings.Contains(message, "No module named 'cv2'"),
		strings.Contains(message, "No module named cv2"),
		strings.Contains(message, "ModuleNotFoundError"):
		return safeMessageError{message: "智能分层依赖未安装，请先执行 `pip install -r tools/remove_background_requirements.txt -t .local/pydeps`"}
	case strings.Contains(message, "HTTPError"),
		strings.Contains(message, "Gateway Time-out"),
		strings.Contains(message, "Read timed out"):
		return safeMessageError{message: "智能分层模型首次下载失败，请重试一次"}
	}
	if message == "" {
		message = commandErr.Error()
	}
	if len(message) > 400 {
		message = message[:400] + "..."
	}
	return safeMessageError{message: "智能分层失败：" + message}
}

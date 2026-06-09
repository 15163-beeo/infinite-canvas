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
	"strings"
	"sync"
	"time"

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
	Input            string `json:"input"`
	BackgroundOutput string `json:"background_output"`
	ProductOutput    string `json:"product_output"`
	MetaOutput       string `json:"meta_output"`
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
}

type LayerImageTextLayer struct {
	Text       string             `json:"text"`
	Position   LayerImagePosition `json:"position"`
	Size       LayerImageSize     `json:"size"`
	FontFamily string             `json:"fontFamily,omitempty"`
	FontWeight string             `json:"fontWeight,omitempty"`
	FontStyle  string             `json:"fontStyle,omitempty"`
	FontSize   float64            `json:"fontSize,omitempty"`
	Color      string             `json:"color,omitempty"`
	Rotation   float64            `json:"rotation,omitempty"`
	Opacity    float64            `json:"opacity,omitempty"`
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

	inputFile, err := os.CreateTemp("", "layer-image-input-*"+imageExtByMime(contentType, filename))
	if err != nil {
		return nil, err
	}
	inputPath := inputFile.Name()
	defer os.Remove(inputPath)
	if _, err := inputFile.Write(data); err != nil {
		_ = inputFile.Close()
		return nil, err
	}
	if err := inputFile.Close(); err != nil {
		return nil, err
	}

	backgroundFile, err := os.CreateTemp("", "layer-image-background-*.png")
	if err != nil {
		return nil, err
	}
	backgroundPath := backgroundFile.Name()
	_ = backgroundFile.Close()
	defer os.Remove(backgroundPath)

	productFile, err := os.CreateTemp("", "layer-image-product-*.png")
	if err != nil {
		return nil, err
	}
	productPath := productFile.Name()
	_ = productFile.Close()
	defer os.Remove(productPath)

	metaFile, err := os.CreateTemp("", "layer-image-meta-*.json")
	if err != nil {
		return nil, err
	}
	metaPath := metaFile.Name()
	_ = metaFile.Close()
	defer os.Remove(metaPath)

	if err := layerImageWithWorker(ctx, inputPath, backgroundPath, productPath, metaPath); err != nil {
		log.Printf("layer image worker failed, fallback to one-shot command: %v", err)
		if fallbackErr := runLayerImageCommand(ctx, inputPath, backgroundPath, productPath, metaPath); fallbackErr != nil {
			return nil, fallbackErr
		}
	}

	background, err := os.ReadFile(backgroundPath)
	if err != nil {
		return nil, err
	}
	product, err := os.ReadFile(productPath)
	if err != nil {
		return nil, err
	}
	if len(background) == 0 || len(product) == 0 {
		return nil, safeMessageError{message: "智能分层结果为空"}
	}

	metaBytes, err := os.ReadFile(metaPath)
	if err != nil {
		return nil, err
	}
	meta := layerImageMeta{}
	if err := json.Unmarshal(metaBytes, &meta); err != nil {
		return nil, err
	}
	if meta.OriginalWidth <= 0 || meta.OriginalHeight <= 0 || meta.ProductWidth <= 0 || meta.ProductHeight <= 0 {
		return nil, safeMessageError{message: "智能分层结果无效"}
	}

	textLayers := meta.TextLayers
	if len(textLayers) == 0 && len(options) > 0 {
		if modelTextLayers, err := detectLayerImageTextLayers(ctx, data, contentType, meta, options[0]); err != nil {
			log.Printf("layer image text detection skipped: %v", err)
		} else if len(modelTextLayers) > 0 {
			textLayers = modelTextLayers
		}
	}

	return &LayerImageResult{
		Background:     background,
		Product:        product,
		TextLayers:     textLayers,
		OriginalWidth:  meta.OriginalWidth,
		OriginalHeight: meta.OriginalHeight,
		ProductOffsetX: meta.ProductOffsetX,
		ProductOffsetY: meta.ProductOffsetY,
		ProductWidth:   meta.ProductWidth,
		ProductHeight:  meta.ProductHeight,
	}, nil
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

func layerImageModelChannel(modelName string, options LayerImageOptions) (model.ModelChannel, error) {
	channelMode := strings.ToLower(strings.TrimSpace(options.ChannelMode))
	if channelMode == "local" {
		channel := normalizeModelChannel(model.ModelChannel{
			ID:      strings.TrimSpace(firstNonEmpty(options.TextChannelID, options.ChannelID)),
			Name:    "用户本地直连",
			BaseURL: strings.TrimSpace(options.BaseURL),
			APIKey:  strings.TrimSpace(options.APIKey),
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
		FontFamily: firstNonEmpty(layerImageStringField(record, "fontFamily", "font_family"), "sans-serif"),
		FontWeight: firstNonEmpty(layerImageStringField(record, "fontWeight", "font_weight"), "normal"),
		FontStyle:  firstNonEmpty(layerImageStringField(record, "fontStyle", "font_style"), "normal"),
		FontSize:   clampFloat(fontSize, 1, float64(max(1, meta.OriginalHeight))),
		Color:      color,
		Rotation:   clampFloat(numberField(record, "rotation", "angle"), -360, 360),
		Opacity:    clampFloat(firstPositive(numberField(record, "opacity"), 1), 0, 1),
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

func layerImageWithWorker(ctx context.Context, inputPath string, backgroundPath string, productPath string, metaPath string) error {
	worker, err := ensureLayerImageWorker(ctx)
	if err != nil {
		return err
	}
	return worker.process(ctx, inputPath, backgroundPath, productPath, metaPath)
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

func (worker *layerImageWorker) process(ctx context.Context, inputPath string, backgroundPath string, productPath string, metaPath string) error {
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

func runLayerImageCommand(ctx context.Context, inputPath string, backgroundPath string, productPath string, metaPath string) error {
	command, err := layerImageCommand(ctx, inputPath, backgroundPath, productPath, metaPath)
	if err != nil {
		return err
	}
	output, err := command.CombinedOutput()
	if err != nil {
		return normalizeLayerImageFailure(err, output)
	}
	return nil
}

func layerImageCommand(ctx context.Context, inputPath string, backgroundPath string, productPath string, metaPath string) (*exec.Cmd, error) {
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

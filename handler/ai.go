package handler

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/service"
)

func AIImagesGenerations(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/images/generations")
}

func AIImagesEdits(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/images/edits")
}

func AIUploadImage(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/uploads/images")
}

func AIChatCompletions(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/chat/completions")
}

func AIResponses(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/responses")
}

func AIVideos(w http.ResponseWriter, r *http.Request) {
	proxyAIRequest(w, r, "/videos")
}

func AIVideo(w http.ResponseWriter, r *http.Request, id string) {
	proxyAIGetRequest(w, r, "/videos/"+id)
}

func AIVideoContent(w http.ResponseWriter, r *http.Request, id string) {
	proxyAIGetRequest(w, r, "/videos/"+id+"/content")
}

func AITask(w http.ResponseWriter, r *http.Request, id string) {
	proxyAIGetRequest(w, r, "/tasks/"+id)
}

func proxyAIGetRequest(w http.ResponseWriter, r *http.Request, path string) {
	startedAt := time.Now()
	user, _ := service.UserFromContext(r.Context())
	modelName := r.URL.Query().Get("model")
	if strings.TrimSpace(modelName) == "" {
		modelName = "grok-imagine-video"
	}
	channel, err := service.SelectModelChannelForModel(modelName, r.Header.Get("X-Model-Channel-ID"))
	if err != nil {
		log.Printf("AI proxy select channel failed: model=%s err=%v", modelName, err)
		Fail(w, "AI 接口请求失败")
		return
	}
	request, err := http.NewRequest(http.MethodGet, service.BuildModelChannelURL(channel, path), nil)
	if err != nil {
		Fail(w, "AI 接口请求失败")
		return
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	copyAIResponse(w, request, channel, aiLogContext{StartedAt: startedAt, Endpoint: path, Method: http.MethodGet, Model: modelName, Channel: channel, UserID: user.ID, UserDisplayName: firstNonEmpty(user.DisplayName, user.Username), RequestBody: summarizeQueryParams(r.URL.Query())}, nil)
}

func proxyAIRequest(w http.ResponseWriter, r *http.Request, path string) {
	startedAt := time.Now()
	body, contentType, modelName, err := readAIRequest(r)
	requestReadDuration := time.Since(startedAt)
	if err != nil {
		log.Printf("AI proxy request read failed: %v", err)
		Fail(w, "AI 接口请求失败")
		return
	}
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	credits, err := service.ModelCost(modelName)
	if err != nil {
		if path != "/uploads/images" {
			log.Printf("AI proxy read model cost failed: model=%s err=%v", modelName, err)
			Fail(w, "AI 接口请求失败")
			return
		}
		credits = 0
	}
	credits *= readAIRequestCount(body, contentType)
	channel, err := service.SelectModelChannelForModel(modelName, r.Header.Get("X-Model-Channel-ID"))
	if err != nil {
		log.Printf("AI proxy select channel failed: model=%s err=%v", modelName, err)
		Fail(w, "AI 接口请求失败")
		return
	}
	upstreamBody := rewriteAIProxyBodyForChannel(path, contentType, body, modelName, channel)
	request, err := http.NewRequest(http.MethodPost, service.BuildModelChannelURL(channel, path), bytes.NewReader(upstreamBody))
	if err != nil {
		log.Printf("AI proxy build request failed: url=%s err=%v", service.BuildModelChannelURL(channel, path), err)
		Fail(w, "AI 接口请求失败")
		return
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	if path == "/uploads/images" && strings.HasPrefix(contentType, "multipart/form-data") {
		if strippedBody, strippedContentType, stripErr := stripAIUploadModelField(body, contentType); stripErr == nil {
			request.Body = io.NopCloser(bytes.NewReader(strippedBody))
			request.GetBody = func() (io.ReadCloser, error) {
				return io.NopCloser(bytes.NewReader(strippedBody)), nil
			}
			request.ContentLength = int64(len(strippedBody))
			request.Header.Set("Content-Type", strippedContentType)
		} else {
			log.Printf("AI upload strip model field failed: %v", stripErr)
		}
	}
	if credits > 0 {
		if err := service.ConsumeUserCredits(user.ID, modelName, credits, path); err != nil {
			FailError(w, err)
			return
		}
	}
	copyAIResponse(w, request, channel, aiLogContext{
		StartedAt:       startedAt,
		Endpoint:        path,
		Method:          http.MethodPost,
		Model:           modelName,
		Channel:         channel,
		UserID:          user.ID,
		UserDisplayName: firstNonEmpty(user.DisplayName, user.Username),
		Credits:         credits,
		RequestBody:     summarizeAIRequest(upstreamBody, contentType),
		RequestBytes:    len(upstreamBody),
		RequestReadTime: requestReadDuration,
	}, func() {
		if credits > 0 {
			if err := service.RefundUserCredits(user.ID, modelName, credits, path); err != nil {
				log.Printf("AI proxy refund credits failed: user=%s model=%s credits=%d err=%v", user.ID, modelName, credits, err)
			}
		}
	})
}

func rewriteAIProxyBodyForChannel(path string, contentType string, body []byte, modelName string, channel model.ModelChannel) []byte {
	if path != "/images/generations" || strings.HasPrefix(contentType, "multipart/form-data") || modelName != "gpt-image-2" || !isAPIMartChannel(channel) {
		return body
	}
	var payload map[string]any
	if err := json.Unmarshal(body, &payload); err != nil {
		return body
	}
	imageURLs, ok := payload["image_urls"].([]any)
	if !ok || len(imageURLs) == 0 {
		return body
	}
	payload["model"] = "gpt-image-2-official"
	delete(payload, "official_fallback")
	encoded, err := json.Marshal(payload)
	if err != nil {
		return body
	}
	return encoded
}

func isAPIMartChannel(channel model.ModelChannel) bool {
	value := strings.ToLower(channel.BaseURL + " " + channel.Name)
	return strings.Contains(value, "apimart.ai") || strings.Contains(value, "apimart")
}

type aiLogContext struct {
	StartedAt       time.Time
	Endpoint        string
	Method          string
	Model           string
	Channel         model.ModelChannel
	UserID          string
	UserDisplayName string
	Credits         int
	RequestBody     string
	RequestBytes    int
	RequestReadTime time.Duration
}

const maxAIProxyAttempts = 2

func copyAIResponse(w http.ResponseWriter, request *http.Request, channel model.ModelChannel, logContext aiLogContext, onFailure func()) {
	client := service.HTTPClientForChannel(channel)
	for attempt := 1; attempt <= maxAIProxyAttempts; attempt++ {
		attemptRequest, err := cloneAIProxyRequest(request)
		if err != nil {
			log.Printf("AI proxy clone request failed: url=%s err=%v", request.URL.String(), err)
			if onFailure != nil {
				onFailure()
			}
			saveAIProxyLog(logContext, 0, "", err.Error())
			FailStatus(w, http.StatusBadGateway, "AI 接口请求失败：请求体无法重试，请重新提交")
			return
		}

		upstreamStartedAt := time.Now()
		response, err := client.Do(attemptRequest)
		upstreamWaitTime := time.Since(upstreamStartedAt)
		if err != nil {
			log.Printf("AI proxy request failed: url=%s attempt=%d/%d err=%v", request.URL.String(), attempt, maxAIProxyAttempts, err)
			logAIProxyTiming(logContext, attempt, 0, upstreamWaitTime, 0, 0, nil, err.Error())
			if shouldRetryAIProxyRequest(0, err, attempt) {
				time.Sleep(aiProxyRetryDelay(attempt))
				continue
			}
			if onFailure != nil {
				onFailure()
			}
			saveAIProxyLog(logContext, 0, "", err.Error())
			FailStatus(w, http.StatusBadGateway, "AI 接口请求失败：无法连接上游接口")
			return
		}

		if response.StatusCode >= http.StatusBadRequest {
			responseReadStartedAt := time.Now()
			payload, _ := io.ReadAll(io.LimitReader(response.Body, 256*1024))
			responseReadTime := time.Since(responseReadStartedAt)
			_ = response.Body.Close()
			log.Printf("AI upstream error: url=%s status=%d attempt=%d/%d body=%s", request.URL.String(), response.StatusCode, attempt, maxAIProxyAttempts, strings.TrimSpace(string(payload)))
			logAIProxyTiming(logContext, attempt, response.StatusCode, upstreamWaitTime, responseReadTime, int64(len(payload)), response.Header, "")
			if shouldRetryAIProxyRequest(response.StatusCode, nil, attempt) {
				time.Sleep(aiProxyRetryDelay(attempt))
				continue
			}
			if onFailure != nil {
				onFailure()
			}
			errorMessage := buildAIUpstreamErrorMessage(response.StatusCode, payload)
			saveAIProxyLog(logContext, response.StatusCode, string(payload), errorMessage)
			FailStatus(w, proxyStatusForAIUpstream(response.StatusCode), errorMessage)
			return
		}

		defer response.Body.Close()
		for key, values := range response.Header {
			if strings.EqualFold(key, "Content-Length") {
				continue
			}
			for _, value := range values {
				w.Header().Add(key, value)
			}
		}
		w.WriteHeader(response.StatusCode)
		responseCopyStartedAt := time.Now()
		responseBody, responseBytes := copyAIResponseBody(w, response.Body)
		responseCopyTime := time.Since(responseCopyStartedAt)
		logAIProxyTiming(logContext, attempt, response.StatusCode, upstreamWaitTime, responseCopyTime, responseBytes, response.Header, "")
		saveAIProxyLog(logContext, response.StatusCode, annotateAIProxyResponseLog(logContext, responseBody, response.Header, responseBytes), "")
		return
	}
	if onFailure != nil {
		onFailure()
	}
	saveAIProxyLog(logContext, 0, "", "AI 接口请求失败")
	FailStatus(w, http.StatusBadGateway, "AI 接口请求失败")
}

func cloneAIProxyRequest(request *http.Request) (*http.Request, error) {
	cloned := request.Clone(request.Context())
	if request.GetBody != nil {
		body, err := request.GetBody()
		if err != nil {
			return nil, err
		}
		cloned.Body = body
	}
	return cloned, nil
}

func shouldRetryAIProxyRequest(status int, err error, attempt int) bool {
	if attempt >= maxAIProxyAttempts {
		return false
	}
	if err != nil {
		return true
	}
	return status == http.StatusInternalServerError ||
		status == http.StatusBadGateway ||
		status == http.StatusServiceUnavailable ||
		status == http.StatusGatewayTimeout
}

func aiProxyRetryDelay(attempt int) time.Duration {
	return time.Duration(attempt) * 800 * time.Millisecond
}

func proxyStatusForAIUpstream(status int) int {
	if status == http.StatusTooManyRequests {
		return http.StatusTooManyRequests
	}
	return http.StatusBadGateway
}

func buildAIUpstreamErrorMessage(status int, payload []byte) string {
	message := extractAIUpstreamErrorMessage(payload)
	if message == "" {
		message = strings.TrimSpace(string(payload))
	}
	if message == "" {
		message = http.StatusText(status)
	}
	message = strings.Join(strings.Fields(message), " ")
	if len([]rune(message)) > 500 {
		runes := []rune(message)
		message = string(runes[:500]) + "..."
	}
	return fmt.Sprintf("AI 上游错误（%d）：%s", status, message)
}

func logAIProxyTiming(context aiLogContext, attempt int, status int, upstreamWaitTime time.Duration, responseCopyTime time.Duration, responseBytes int64, headers http.Header, errorMessage string) {
	log.Printf(
		"AI proxy timing: endpoint=%s model=%s channel=%s channelId=%s status=%d attempt=%d/%d requestReadMs=%d upstreamWaitMs=%d responseCopyMs=%d totalMs=%d requestBytes=%d responseBytes=%d upstreamHeaders=%q error=%q",
		context.Endpoint,
		context.Model,
		context.Channel.Name,
		context.Channel.ID,
		status,
		attempt,
		maxAIProxyAttempts,
		context.RequestReadTime.Milliseconds(),
		upstreamWaitTime.Milliseconds(),
		responseCopyTime.Milliseconds(),
		time.Since(context.StartedAt).Milliseconds(),
		context.RequestBytes,
		responseBytes,
		summarizeAIUpstreamHeaders(headers),
		errorMessage,
	)
}

func summarizeAIUpstreamHeaders(headers http.Header) string {
	if len(headers) == 0 {
		return ""
	}
	keys := []string{
		"Content-Type",
		"X-Request-Id",
		"Request-Id",
		"OpenAI-Request-ID",
		"CF-Ray",
		"X-Trace-Id",
		"Traceparent",
		"X-Zlybk-Request-Id",
	}
	seen := map[string]bool{}
	parts := []string{}
	for _, key := range keys {
		normalizedKey := strings.ToLower(key)
		if seen[normalizedKey] {
			continue
		}
		seen[normalizedKey] = true
		if value := strings.TrimSpace(headers.Get(key)); value != "" {
			parts = append(parts, key+"="+value)
		}
	}
	return strings.Join(parts, "; ")
}

func extractAIUpstreamErrorMessage(payload []byte) string {
	var decoded struct {
		Error   any    `json:"error"`
		Msg     string `json:"msg"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(payload, &decoded); err != nil {
		return ""
	}
	if decoded.Msg != "" {
		return decoded.Msg
	}
	if decoded.Message != "" {
		return decoded.Message
	}
	switch value := decoded.Error.(type) {
	case string:
		return value
	case map[string]any:
		if message, ok := value["message"].(string); ok {
			return message
		}
	}
	return ""
}

func copyAIResponseBody(w http.ResponseWriter, body io.Reader) (string, int64) {
	flusher, canFlush := w.(http.Flusher)
	buffer := make([]byte, 32*1024)
	var logBuffer strings.Builder
	var totalBytes int64
	for {
		n, err := body.Read(buffer)
		if n > 0 {
			totalBytes += int64(n)
			if _, writeErr := w.Write(buffer[:n]); writeErr != nil {
				return logBuffer.String(), totalBytes
			}
			if logBuffer.Len() < 64*1024 {
				_, _ = logBuffer.Write(buffer[:min(n, 64*1024-logBuffer.Len())])
			}
			if canFlush {
				flusher.Flush()
			}
		}
		if err != nil {
			return logBuffer.String(), totalBytes
		}
	}
}

func saveAIProxyLog(context aiLogContext, status int, responseBody string, errorMessage string) {
	if context.StartedAt.IsZero() {
		context.StartedAt = time.Now()
	}
	service.SaveAICallLog(service.AICallLogInput{
		UserID:          context.UserID,
		UserDisplayName: context.UserDisplayName,
		Endpoint:        context.Endpoint,
		Method:          context.Method,
		Model:           context.Model,
		ChannelID:       context.Channel.ID,
		ChannelName:     context.Channel.Name,
		Status:          status,
		DurationMs:      time.Since(context.StartedAt).Milliseconds(),
		Credits:         context.Credits,
		RequestBody:     context.RequestBody,
		ResponseBody:    responseBody,
		Error:           errorMessage,
	})
}

func annotateAIProxyResponseLog(context aiLogContext, responseBody string, headers http.Header, responseBytes int64) string {
	dimensions := extractPNGDimensionsFromB64JSON(responseBody)
	if len(dimensions) == 0 {
		return responseBody
	}
	payload := map[string]any{
		"proxyDiagnostics": map[string]any{
			"endpoint":                context.Endpoint,
			"model":                   context.Model,
			"channelId":               context.Channel.ID,
			"channelName":             context.Channel.Name,
			"requestSize":             extractRequestSizeFromLog(context.RequestBody),
			"responseImageDimensions": dimensions,
			"responseBytes":           responseBytes,
			"upstreamHeaders":         summarizeAIUpstreamHeaders(headers),
		},
		"upstreamResponse": responseBody,
	}
	if encoded, err := json.MarshalIndent(payload, "", "  "); err == nil {
		return string(encoded)
	}
	return responseBody
}

func extractRequestSizeFromLog(requestBody string) string {
	var payload struct {
		Fields map[string][]string `json:"fields"`
		Size   string              `json:"size"`
	}
	if err := json.Unmarshal([]byte(requestBody), &payload); err != nil {
		return ""
	}
	if values := payload.Fields["size"]; len(values) > 0 {
		return values[0]
	}
	return payload.Size
}

func extractPNGDimensionsFromB64JSON(responseBody string) []string {
	const marker = `"b64_json":"`
	dimensions := []string{}
	for offset := 0; ; {
		index := strings.Index(responseBody[offset:], marker)
		if index < 0 {
			break
		}
		start := offset + index + len(marker)
		head := responseBody[start:min(len(responseBody), start+96)]
		if dimension := decodePNGDimensionFromBase64Head(head); dimension != "" {
			dimensions = append(dimensions, dimension)
		}
		offset = start
	}
	return dimensions
}

func decodePNGDimensionFromBase64Head(head string) string {
	cleaned := strings.Builder{}
	for _, char := range head {
		if char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z' || char >= '0' && char <= '9' || char == '+' || char == '/' || char == '=' {
			cleaned.WriteRune(char)
			continue
		}
		break
	}
	value := cleaned.String()
	if value == "" {
		return ""
	}
	for len(value)%4 != 0 {
		value += "="
	}
	raw, err := base64.StdEncoding.DecodeString(value)
	if err != nil || len(raw) < 24 || !bytes.HasPrefix(raw, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}) {
		return ""
	}
	width := binary.BigEndian.Uint32(raw[16:20])
	height := binary.BigEndian.Uint32(raw[20:24])
	if width == 0 || height == 0 {
		return ""
	}
	return fmt.Sprintf("%dx%d", width, height)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func summarizeAIRequest(body []byte, contentType string) string {
	if strings.HasPrefix(contentType, "multipart/form-data") {
		return summarizeMultipartAIRequest(body, contentType)
	}
	var payload any
	if err := json.Unmarshal(body, &payload); err == nil {
		redactLargeImages(&payload)
		if encoded, err := json.MarshalIndent(payload, "", "  "); err == nil {
			return string(encoded)
		}
	}
	return string(body)
}

func summarizeQueryParams(values map[string][]string) string {
	if len(values) == 0 {
		return ""
	}
	encoded, _ := json.MarshalIndent(values, "", "  ")
	return string(encoded)
}

func summarizeMultipartAIRequest(body []byte, contentType string) string {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return "multipart/form-data"
	}
	form, err := multipart.NewReader(bytes.NewReader(body), params["boundary"]).ReadForm(32 << 20)
	if err != nil {
		return "multipart/form-data"
	}
	defer form.RemoveAll()
	summary := map[string]any{"fields": form.Value}
	files := []map[string]any{}
	for field, headers := range form.File {
		for _, header := range headers {
			files = append(files, map[string]any{"field": field, "filename": header.Filename, "size": header.Size, "contentType": header.Header.Get("Content-Type")})
		}
	}
	summary["files"] = files
	encoded, _ := json.MarshalIndent(summary, "", "  ")
	return string(encoded)
}

func redactLargeImages(value *any) {
	switch typed := (*value).(type) {
	case map[string]any:
		for key, item := range typed {
			if text, ok := item.(string); ok && (strings.HasPrefix(text, "data:image/") || len(text) > 2048 && looksLikeBase64(text)) {
				typed[key] = fmt.Sprintf("[redacted image/string len=%d]", len(text))
				continue
			}
			redactLargeImages(&item)
			typed[key] = item
		}
	case []any:
		for index, item := range typed {
			redactLargeImages(&item)
			typed[index] = item
		}
	}
}

func looksLikeBase64(value string) bool {
	for _, char := range value[:min(len(value), 200)] {
		if !(char >= 'A' && char <= 'Z' || char >= 'a' && char <= 'z' || char >= '0' && char <= '9' || char == '+' || char == '/' || char == '=') {
			return false
		}
	}
	return true
}

func readAIRequest(r *http.Request) ([]byte, string, string, error) {
	contentType := r.Header.Get("Content-Type")
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, "", "", err
	}
	modelName := ""
	if strings.HasPrefix(contentType, "multipart/form-data") {
		modelName = readMultipartModel(body, contentType)
	} else {
		var payload struct {
			Model string `json:"model"`
		}
		_ = json.Unmarshal(body, &payload)
		modelName = payload.Model
	}
	if strings.TrimSpace(modelName) == "" {
		return nil, "", "", errMissingModel
	}
	return body, contentType, modelName, nil
}

func readMultipartModel(body []byte, contentType string) string {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return ""
	}
	reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
	form, err := reader.ReadForm(32 << 20)
	if err != nil {
		return ""
	}
	defer form.RemoveAll()
	if values := form.Value["model"]; len(values) > 0 {
		return values[0]
	}
	return ""
}

func stripAIUploadModelField(body []byte, contentType string) ([]byte, string, error) {
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return nil, "", err
	}
	form, err := multipart.NewReader(bytes.NewReader(body), params["boundary"]).ReadForm(32 << 20)
	if err != nil {
		return nil, "", err
	}
	defer form.RemoveAll()
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	for key, values := range form.Value {
		if key == "model" {
			continue
		}
		for _, value := range values {
			if err := writer.WriteField(key, value); err != nil {
				return nil, "", err
			}
		}
	}
	for key, files := range form.File {
		for _, fileHeader := range files {
			source, err := fileHeader.Open()
			if err != nil {
				return nil, "", err
			}
			part, err := writer.CreateFormFile(key, fileHeader.Filename)
			if err != nil {
				_ = source.Close()
				return nil, "", err
			}
			if _, err := io.Copy(part, source); err != nil {
				_ = source.Close()
				return nil, "", err
			}
			if err := source.Close(); err != nil {
				return nil, "", err
			}
		}
	}
	if err := writer.Close(); err != nil {
		return nil, "", err
	}
	return buffer.Bytes(), writer.FormDataContentType(), nil
}

func readAIRequestCount(body []byte, contentType string) int {
	count := 1
	if strings.HasPrefix(contentType, "multipart/form-data") {
		_, params, err := mime.ParseMediaType(contentType)
		if err != nil {
			return count
		}
		form, err := multipart.NewReader(bytes.NewReader(body), params["boundary"]).ReadForm(32 << 20)
		if err != nil {
			return count
		}
		defer form.RemoveAll()
		if values := form.Value["n"]; len(values) > 0 {
			_, _ = fmt.Sscan(values[0], &count)
		}
	} else {
		var payload struct {
			N int `json:"n"`
		}
		_ = json.Unmarshal(body, &payload)
		count = payload.N
	}
	if count < 1 {
		return 1
	}
	return count
}

var errMissingModel = &aiError{"缺少模型名称"}

type aiError struct {
	message string
}

func (err *aiError) Error() string {
	return err.message
}

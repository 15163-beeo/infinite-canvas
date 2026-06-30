package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/google/uuid"
)

type AestheticMirrorJobStatus string

const (
	AestheticMirrorJobQueued  AestheticMirrorJobStatus = "queued"
	AestheticMirrorJobRunning AestheticMirrorJobStatus = "running"
	AestheticMirrorJobSuccess AestheticMirrorJobStatus = "success"
	AestheticMirrorJobFailed  AestheticMirrorJobStatus = "failed"
)

const (
	aestheticMirrorJobConcurrency = 6
	aestheticMirrorJobTimeout     = 15 * time.Minute
	aestheticMirrorRetryAttempts  = 6
)

const (
	aestheticMirrorAPIMartGptImage2Model          = "gpt-image-2"
	aestheticMirrorAPIMartGptImage2OfficialModel  = "gpt-image-2-official"
	aestheticMirrorAPIMartTaskPollInterval        = 3 * time.Second
	aestheticMirrorAPIMartGptImage2MaxWaitSeconds = 240
)

type AestheticMirrorJobImageInput struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	StorageKey string `json:"storageKey"`
	DataURL    string `json:"dataUrl"`
}

type AestheticMirrorJobMetadata struct {
	ReferenceIndex int `json:"referenceIndex"`
	GroupIndex     int `json:"groupIndex"`
}

type AestheticMirrorJobCreateInput struct {
	Prompt         string                         `json:"prompt"`
	PromptTemplate string                         `json:"promptTemplate"`
	ExtraPrompt    string                         `json:"extraPrompt"`
	Model          string                         `json:"model"`
	ChannelID      string                         `json:"channelId"`
	Size           string                         `json:"size"`
	Quality        string                         `json:"quality"`
	OutputFormat   string                         `json:"outputFormat"`
	ReferenceImage AestheticMirrorJobImageInput   `json:"referenceImage"`
	ProductImages  []AestheticMirrorJobImageInput `json:"productImages"`
	Metadata       AestheticMirrorJobMetadata     `json:"metadata"`
}

type AestheticMirrorJob struct {
	ID             string                   `json:"id"`
	Status         AestheticMirrorJobStatus `json:"status"`
	ReferenceIndex int                      `json:"referenceIndex"`
	GroupIndex     int                      `json:"groupIndex"`
	ImageDataURL   string                   `json:"imageDataUrl,omitempty"`
	Error          string                   `json:"error,omitempty"`
	CreatedAt      int64                    `json:"createdAt"`
	StartedAt      int64                    `json:"startedAt,omitempty"`
	FinishedAt     int64                    `json:"finishedAt,omitempty"`
}

type aestheticMirrorStoredJob struct {
	AestheticMirrorJob
	OwnerUserID string
}

type aestheticMirrorJobManager struct {
	mu    sync.RWMutex
	jobs  map[string]aestheticMirrorStoredJob
	limit chan struct{}
}

var mirrorJobs = &aestheticMirrorJobManager{
	jobs:  map[string]aestheticMirrorStoredJob{},
	limit: make(chan struct{}, aestheticMirrorJobConcurrency),
}

var aestheticMirrorAPIMartLimit = make(chan struct{}, 1)

func CreateAestheticMirrorJob(ctx context.Context, token string, input AestheticMirrorJobCreateInput) (AestheticMirrorJob, error) {
	user, ok := UserFromContext(ctx)
	if !ok || strings.TrimSpace(user.ID) == "" {
		return AestheticMirrorJob{}, safeMessageError{message: "未登录或权限不足"}
	}
	if strings.TrimSpace(token) == "" {
		return AestheticMirrorJob{}, safeMessageError{message: "请先登录后再使用批量复刻"}
	}
	if strings.TrimSpace(input.Prompt) == "" {
		return AestheticMirrorJob{}, safeMessageError{message: "提示词不能为空"}
	}
	if strings.TrimSpace(input.Model) == "" {
		return AestheticMirrorJob{}, safeMessageError{message: "模型不能为空"}
	}
	if len(input.ProductImages) == 0 {
		return AestheticMirrorJob{}, safeMessageError{message: "产品素材图不能为空"}
	}
	if !isValidAestheticMirrorImageInput(input.ReferenceImage) {
		return AestheticMirrorJob{}, safeMessageError{message: "参考设计图不能为空"}
	}

	now := time.Now().UnixMilli()
	job := aestheticMirrorStoredJob{
		AestheticMirrorJob: AestheticMirrorJob{
			ID:             uuid.NewString(),
			Status:         AestheticMirrorJobQueued,
			ReferenceIndex: input.Metadata.ReferenceIndex,
			GroupIndex:     input.Metadata.GroupIndex,
			CreatedAt:      now,
		},
		OwnerUserID: user.ID,
	}

	mirrorJobs.mu.Lock()
	mirrorJobs.jobs[job.ID] = job
	mirrorJobs.mu.Unlock()

	go mirrorJobs.run(job.ID, user, token, input)

	return job.AestheticMirrorJob, nil
}

func GetAestheticMirrorJob(ctx context.Context, id string) (AestheticMirrorJob, error) {
	user, ok := UserFromContext(ctx)
	if !ok || strings.TrimSpace(user.ID) == "" {
		return AestheticMirrorJob{}, safeMessageError{message: "未登录或权限不足"}
	}
	job, found := mirrorJobs.get(id)
	if !found || (job.OwnerUserID != "" && job.OwnerUserID != user.ID && user.Role != model.UserRoleAdmin) {
		return AestheticMirrorJob{}, safeMessageError{message: "任务不存在"}
	}
	return job.AestheticMirrorJob, nil
}

func (manager *aestheticMirrorJobManager) get(id string) (aestheticMirrorStoredJob, bool) {
	manager.mu.RLock()
	defer manager.mu.RUnlock()
	job, ok := manager.jobs[id]
	return job, ok
}

func (manager *aestheticMirrorJobManager) update(id string, mutate func(*aestheticMirrorStoredJob)) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	job, ok := manager.jobs[id]
	if !ok {
		return
	}
	mutate(&job)
	manager.jobs[id] = job
}

func (manager *aestheticMirrorJobManager) run(jobID string, user model.AuthUser, token string, input AestheticMirrorJobCreateInput) {
	manager.limit <- struct{}{}
	defer func() { <-manager.limit }()

	manager.update(jobID, func(job *aestheticMirrorStoredJob) {
		job.Status = AestheticMirrorJobRunning
		job.StartedAt = time.Now().UnixMilli()
		job.Error = ""
	})

	imageDataURL, err := executeAestheticMirrorJob(user, token, input)
	finishedAt := time.Now().UnixMilli()
	if err != nil {
		manager.update(jobID, func(job *aestheticMirrorStoredJob) {
			job.Status = AestheticMirrorJobFailed
			job.Error = err.Error()
			job.FinishedAt = finishedAt
		})
		return
	}

	manager.update(jobID, func(job *aestheticMirrorStoredJob) {
		job.Status = AestheticMirrorJobSuccess
		job.ImageDataURL = imageDataURL
		job.Error = ""
		job.FinishedAt = finishedAt
	})
}

func executeAestheticMirrorJob(user model.AuthUser, token string, input AestheticMirrorJobCreateInput) (string, error) {
	requestCtx, cancel := context.WithTimeout(context.Background(), aestheticMirrorJobTimeout)
	defer cancel()

	resolvedPrompt := buildAestheticMirrorJobPrompt(requestCtx, user, input)
	if strings.TrimSpace(resolvedPrompt) == "" {
		resolvedPrompt = strings.TrimSpace(input.Prompt)
	}
	if strings.TrimSpace(resolvedPrompt) == "" {
		log.Printf("aesthetic mirror resolved prompt empty reference=%d group=%d", input.Metadata.ReferenceIndex, input.Metadata.GroupIndex)
		return "", safeMessageError{message: "批量复刻提示词不能为空"}
	}

	channel, err := SelectModelChannelForModel(strings.TrimSpace(input.Model), strings.TrimSpace(input.ChannelID))
	if err != nil {
		return "", err
	}
	if isAestheticMirrorAPIMartChannel(channel) {
		aestheticMirrorAPIMartLimit <- struct{}{}
		defer func() { <-aestheticMirrorAPIMartLimit }()
	}
	useAPIMartGenerationFlow := isAestheticMirrorAPIMartGptImage2Channel(channel, input.Model)

	var lastErr error
	for attempt := 1; attempt <= aestheticMirrorRetryAttempts; attempt++ {
		var imageDataURL string
		var err error
		if useAPIMartGenerationFlow {
			imageDataURL, err = submitAestheticMirrorAPIMartGeneration(requestCtx, user, token, input, resolvedPrompt)
		} else {
			imageDataURL, err = submitAestheticMirrorEdit(requestCtx, user, token, input, resolvedPrompt)
		}
		if err == nil {
			return imageDataURL, nil
		}
		lastErr = err
		if !shouldRetryAestheticMirrorError(channel, err, attempt) {
			return "", err
		}
		delay := aestheticMirrorRetryDelay(attempt)
		log.Printf("aesthetic mirror upstream retry scheduled channel=%s reference=%d group=%d attempt=%d/%d delay=%s err=%v", channel.Name, input.Metadata.ReferenceIndex, input.Metadata.GroupIndex, attempt, aestheticMirrorRetryAttempts, delay, err)
		select {
		case <-time.After(delay):
		case <-requestCtx.Done():
			return "", safeMessageError{message: "批量复刻任务等待超时"}
		}
	}

	return "", lastErr
}

func submitAestheticMirrorEdit(requestCtx context.Context, user model.AuthUser, token string, input AestheticMirrorJobCreateInput, resolvedPrompt string) (string, error) {

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)

	fields := map[string]string{
		"model":           strings.TrimSpace(input.Model),
		"prompt":          resolvedPrompt,
		"output_format":   firstNonEmptyString(strings.TrimSpace(input.OutputFormat), "png"),
		"moderation":      "auto",
		"n":               "1",
		"response_format": "b64_json",
	}
	if size := strings.TrimSpace(input.Size); size != "" && size != "auto" {
		fields["size"] = size
	}
	if quality := strings.TrimSpace(input.Quality); quality != "" && quality != "auto" {
		fields["quality"] = quality
	}
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			return "", err
		}
	}

	images := append([]AestheticMirrorJobImageInput{input.ReferenceImage}, input.ProductImages...)
	for index, image := range images {
		data, filename, mimeType, err := resolveAestheticMirrorJobImage(requestCtx, user, image, index == 0)
		if err != nil {
			return "", err
		}
		part, err := writer.CreateFormFile("image[]", chooseAestheticMirrorFilename(filename, mimeType, index == 0))
		if err != nil {
			return "", err
		}
		if _, err := part.Write(data); err != nil {
			return "", err
		}
	}
	if err := writer.Close(); err != nil {
		return "", err
	}

	target := fmt.Sprintf("http://127.0.0.1:%s/api/v1/images/edits", firstNonEmptyString(strings.TrimSpace(config.Cfg.Port), "18080"))
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, target, bytes.NewReader(body.Bytes()))
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	if channelID := strings.TrimSpace(input.ChannelID); channelID != "" {
		request.Header.Set("X-Model-Channel-ID", channelID)
	}

	response, err := (&http.Client{Timeout: aestheticMirrorJobTimeout}).Do(request)
	if err != nil {
		return "", safeMessageError{message: "批量复刻任务提交失败：" + err.Error()}
	}
	defer response.Body.Close()

	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", safeMessageError{message: parseAestheticMirrorHTTPError(responseBody, response.Status)}
	}
	return parseAestheticMirrorResponse(requestCtx, responseBody)
}

func submitAestheticMirrorAPIMartGeneration(requestCtx context.Context, user model.AuthUser, token string, input AestheticMirrorJobCreateInput, resolvedPrompt string) (string, error) {
	images := append([]AestheticMirrorJobImageInput{input.ReferenceImage}, input.ProductImages...)
	imageURLs := make([]string, 0, len(images))
	for index, image := range images {
		imageURL, err := uploadAestheticMirrorAPIMartImage(requestCtx, user, token, image, index == 0, input.ChannelID)
		if err != nil {
			return "", err
		}
		imageURLs = append(imageURLs, imageURL)
	}
	if len(imageURLs) == 0 {
		return "", safeMessageError{message: "批量复刻图片不能为空"}
	}

	payload := map[string]any{
		"model":             aestheticMirrorAPIMartGptImage2Model,
		"prompt":            resolvedPrompt,
		"n":                 1,
		"resolution":        aestheticMirrorAPIMartResolutionForSize(input.Size),
		"image_urls":        imageURLs,
		"official_fallback": true,
	}
	if size := strings.TrimSpace(input.Size); size != "" && size != "auto" {
		payload["size"] = size
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, aestheticMirrorLocalAPIURL("/images/generations"), bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	if channelID := strings.TrimSpace(input.ChannelID); channelID != "" {
		request.Header.Set("X-Model-Channel-ID", channelID)
	}

	response, err := (&http.Client{Timeout: aestheticMirrorJobTimeout}).Do(request)
	if err != nil {
		return "", safeMessageError{message: "批量复刻任务提交失败：" + err.Error()}
	}
	defer response.Body.Close()

	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", safeMessageError{message: parseAestheticMirrorHTTPError(responseBody, response.Status)}
	}
	taskID, err := parseAestheticMirrorAPIMartTaskID(responseBody)
	if err != nil {
		return "", err
	}
	return pollAestheticMirrorAPIMartTask(requestCtx, token, strings.TrimSpace(input.ChannelID), taskID)
}

func uploadAestheticMirrorAPIMartImage(requestCtx context.Context, user model.AuthUser, token string, input AestheticMirrorJobImageInput, isReference bool, channelID string) (string, error) {
	data, filename, mimeType, err := resolveAestheticMirrorJobImage(requestCtx, user, input, isReference)
	if err != nil {
		return "", err
	}

	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	if err := writer.WriteField("model", aestheticMirrorAPIMartGptImage2Model); err != nil {
		return "", err
	}
	part, err := writer.CreateFormFile("file", chooseAestheticMirrorFilename(filename, mimeType, isReference))
	if err != nil {
		return "", err
	}
	if _, err := part.Write(data); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}

	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, aestheticMirrorLocalAPIURL("/uploads/images"), bytes.NewReader(body.Bytes()))
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	if trimmed := strings.TrimSpace(channelID); trimmed != "" {
		request.Header.Set("X-Model-Channel-ID", trimmed)
	}

	response, err := (&http.Client{Timeout: aestheticMirrorJobTimeout}).Do(request)
	if err != nil {
		return "", safeMessageError{message: "批量复刻图片上传失败：" + err.Error()}
	}
	defer response.Body.Close()

	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", safeMessageError{message: parseAestheticMirrorHTTPError(responseBody, response.Status)}
	}

	var payload struct {
		URL     string `json:"url"`
		Data    any    `json:"data"`
		Error   any    `json:"error"`
		Code    int    `json:"code"`
		Msg     string `json:"msg"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(responseBody, &payload); err != nil {
		return "", safeMessageError{message: "图片上传返回异常"}
	}
	if !isAestheticMirrorAPIMartSuccessCode(payload.Code) {
		return "", safeMessageError{message: firstNonEmptyString(strings.TrimSpace(payload.Msg), strings.TrimSpace(payload.Message), extractAestheticMirrorErrorMessage(payload.Error), "图片上传失败")}
	}
	if value := strings.TrimSpace(payload.URL); value != "" {
		return value, nil
	}
	if value := extractAestheticMirrorURL(payload.Data); value != "" {
		return value, nil
	}
	return "", safeMessageError{message: "图片上传后没有返回 URL"}
}

func parseAestheticMirrorAPIMartTaskID(body []byte) (string, error) {
	var payload struct {
		Data []struct {
			TaskID string `json:"task_id"`
			ID     string `json:"id"`
		} `json:"data"`
		Error   any    `json:"error"`
		Code    int    `json:"code"`
		Msg     string `json:"msg"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", safeMessageError{message: "批量复刻提交返回异常"}
	}
	if !isAestheticMirrorAPIMartSuccessCode(payload.Code) {
		return "", safeMessageError{message: firstNonEmptyString(strings.TrimSpace(payload.Msg), strings.TrimSpace(payload.Message), extractAestheticMirrorErrorMessage(payload.Error), "批量复刻提交失败")}
	}
	if len(payload.Data) > 0 {
		taskID := firstNonEmptyString(strings.TrimSpace(payload.Data[0].TaskID), strings.TrimSpace(payload.Data[0].ID))
		if taskID != "" {
			return taskID, nil
		}
	}
	return "", safeMessageError{message: "批量复刻提交后没有返回任务 ID"}
}

func pollAestheticMirrorAPIMartTask(ctx context.Context, token string, channelID string, taskID string) (string, error) {
	deadline := time.Now().Add(time.Duration(aestheticMirrorAPIMartGptImage2MaxWaitSeconds) * time.Second)
	for time.Now().Before(deadline) {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, aestheticMirrorLocalAPIURL("/tasks/"+url.PathEscape(taskID))+"?model="+url.QueryEscape(aestheticMirrorAPIMartGptImage2Model), nil)
		if err != nil {
			return "", err
		}
		request.Header.Set("Authorization", "Bearer "+token)
		if trimmed := strings.TrimSpace(channelID); trimmed != "" {
			request.Header.Set("X-Model-Channel-ID", trimmed)
		}

		response, err := (&http.Client{Timeout: aestheticMirrorJobTimeout}).Do(request)
		if err != nil {
			return "", safeMessageError{message: "批量复刻任务查询失败：" + err.Error()}
		}
		responseBody, _ := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return "", safeMessageError{message: parseAestheticMirrorHTTPError(responseBody, response.Status)}
		}

		var payload struct {
			Data struct {
				Status   string  `json:"status"`
				Progress float64 `json:"progress"`
				Result   struct {
					Images []any `json:"images"`
				} `json:"result"`
				Error any `json:"error"`
			} `json:"data"`
			Error   any    `json:"error"`
			Code    int    `json:"code"`
			Msg     string `json:"msg"`
			Message string `json:"message"`
		}
		if err := json.Unmarshal(responseBody, &payload); err != nil {
			return "", safeMessageError{message: "批量复刻任务查询返回异常"}
		}
		if !isAestheticMirrorAPIMartSuccessCode(payload.Code) {
			return "", safeMessageError{message: firstNonEmptyString(strings.TrimSpace(payload.Msg), strings.TrimSpace(payload.Message), extractAestheticMirrorErrorMessage(payload.Error), "批量复刻任务查询失败")}
		}

		status := strings.ToLower(strings.TrimSpace(payload.Data.Status))
		switch status {
		case "completed", "success", "succeeded":
			for _, image := range payload.Data.Result.Images {
				if imageURL := extractAestheticMirrorURL(image); imageURL != "" {
					if strings.HasPrefix(imageURL, "data:") {
						return imageURL, nil
					}
					return downloadAestheticMirrorResultURL(ctx, imageURL)
				}
			}
			return "", safeMessageError{message: "APIMart 任务已完成但没有返回图片 URL"}
		case "failed", "failure", "cancelled", "canceled":
			return "", safeMessageError{message: firstNonEmptyString(extractAestheticMirrorErrorMessage(payload.Data.Error), "APIMart 图片任务失败")}
		}

		wait := time.Until(deadline)
		if wait > aestheticMirrorAPIMartTaskPollInterval {
			wait = aestheticMirrorAPIMartTaskPollInterval
		}
		select {
		case <-time.After(wait):
		case <-ctx.Done():
			return "", safeMessageError{message: "批量复刻任务等待超时"}
		}
	}

	return "", safeMessageError{message: fmt.Sprintf("APIMart gpt-image-2 任务超过 %d 秒仍未完成", aestheticMirrorAPIMartGptImage2MaxWaitSeconds)}
}

func isAestheticMirrorAPIMartSuccessCode(code int) bool {
	return code == 0 || code == 200
}

func extractAestheticMirrorURL(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case map[string]any:
		for _, key := range []string{"url", "urls", "image_url"} {
			if value := extractAestheticMirrorURL(typed[key]); value != "" {
				return value
			}
		}
	case []any:
		for _, item := range typed {
			if value := extractAestheticMirrorURL(item); value != "" {
				return value
			}
		}
	}
	return ""
}

func isAestheticMirrorAPIMartChannel(channel model.ModelChannel) bool {
	value := strings.ToLower(strings.TrimSpace(channel.BaseURL + " " + channel.Name))
	return strings.Contains(value, "apimart.ai") || strings.Contains(value, "apimart")
}

func isAestheticMirrorAPIMartGptImage2Channel(channel model.ModelChannel, modelName string) bool {
	if !isAestheticMirrorAPIMartChannel(channel) {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(modelName)) {
	case aestheticMirrorAPIMartGptImage2Model, aestheticMirrorAPIMartGptImage2OfficialModel, "novadream-img-2":
		return true
	default:
		return false
	}
}

func shouldRetryAestheticMirrorError(channel model.ModelChannel, err error, attempt int) bool {
	if attempt >= aestheticMirrorRetryAttempts || err == nil {
		return false
	}
	if !isAestheticMirrorAPIMartChannel(channel) {
		return false
	}
	message := strings.ToLower(strings.TrimSpace(err.Error()))
	return strings.Contains(message, "please wait and try again later") ||
		strings.Contains(message, "thank you for your patience") ||
		strings.Contains(message, "429") ||
		strings.Contains(message, "500") ||
		strings.Contains(message, "502") ||
		strings.Contains(message, "503") ||
		strings.Contains(message, "504") ||
		strings.Contains(message, "timeout") ||
		strings.Contains(message, "限流") ||
		strings.Contains(message, "繁忙") ||
		strings.Contains(message, "上游错误")
}

func aestheticMirrorRetryDelay(attempt int) time.Duration {
	switch attempt {
	case 1:
		return 8 * time.Second
	case 2:
		return 15 * time.Second
	case 3:
		return 25 * time.Second
	case 4:
		return 35 * time.Second
	default:
		return 45 * time.Second
	}
}

func resolveAestheticMirrorJobImage(ctx context.Context, user model.AuthUser, input AestheticMirrorJobImageInput, isReference bool) ([]byte, string, string, error) {
	if storageKey := strings.TrimSpace(input.StorageKey); strings.HasPrefix(storageKey, "server:") {
		id := strings.TrimPrefix(storageKey, "server:")
		object, err := StorageObjectInfo(id)
		if err != nil {
			return nil, "", "", safeMessageError{message: "读取图片失败"}
		}
		if object.CreatedBy != "" && object.CreatedBy != user.ID && user.Role != model.UserRoleAdmin {
			return nil, "", "", safeMessageError{message: "图片无权访问"}
		}
		downloaded, err := DownloadStorageObject(id)
		if err != nil {
			return nil, "", "", safeMessageError{message: "读取图片失败"}
		}
		mimeType := firstNonEmptyString(strings.TrimSpace(input.Type), strings.TrimSpace(downloaded.Object.MimeType), strings.TrimSpace(http.DetectContentType(downloaded.Data)))
		return downloaded.Data, input.Name, mimeType, nil
	}

	dataURL := strings.TrimSpace(input.DataURL)
	if dataURL == "" {
		return nil, "", "", safeMessageError{message: map[bool]string{true: "参考设计图不能为空", false: "产品素材图不能为空"}[isReference]}
	}
	if strings.HasPrefix(dataURL, "data:") {
		data, mimeType, err := decodeAestheticMirrorDataURL(dataURL)
		if err != nil {
			return nil, "", "", safeMessageError{message: "读取图片失败"}
		}
		return data, input.Name, firstNonEmptyString(strings.TrimSpace(input.Type), mimeType, strings.TrimSpace(http.DetectContentType(data))), nil
	}
	if strings.HasPrefix(dataURL, "http://") || strings.HasPrefix(dataURL, "https://") {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, dataURL, nil)
		if err != nil {
			return nil, "", "", err
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			return nil, "", "", safeMessageError{message: "读取图片失败"}
		}
		defer response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return nil, "", "", safeMessageError{message: "读取图片失败"}
		}
		data, err := io.ReadAll(response.Body)
		if err != nil {
			return nil, "", "", safeMessageError{message: "读取图片失败"}
		}
		mimeType := firstNonEmptyString(strings.TrimSpace(input.Type), strings.TrimSpace(response.Header.Get("Content-Type")), strings.TrimSpace(http.DetectContentType(data)))
		return data, input.Name, mimeType, nil
	}
	return nil, "", "", safeMessageError{message: "读取图片失败"}
}

func parseAestheticMirrorResponse(ctx context.Context, body []byte) (string, error) {
	var payload struct {
		Data []struct {
			B64JSON string `json:"b64_json"`
			URL     string `json:"url"`
		} `json:"data"`
		Error any    `json:"error"`
		Code  int    `json:"code"`
		Msg   string `json:"msg"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return "", safeMessageError{message: "批量复刻返回异常"}
	}
	if payload.Code != 0 {
		return "", safeMessageError{message: firstNonEmptyString(strings.TrimSpace(payload.Msg), extractAestheticMirrorErrorMessage(payload.Error), "批量复刻失败")}
	}
	for _, item := range payload.Data {
		if value := strings.TrimSpace(item.B64JSON); value != "" {
			return normalizeAestheticMirrorBase64Image(value, "image/png"), nil
		}
		if value := strings.TrimSpace(item.URL); value != "" {
			return downloadAestheticMirrorResultURL(ctx, value)
		}
	}
	if message := extractAestheticMirrorErrorMessage(payload.Error); message != "" {
		return "", safeMessageError{message: message}
	}
	return "", safeMessageError{message: "接口没有返回图片"}
}

func parseAestheticMirrorHTTPError(body []byte, status string) string {
	var payload struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
		Msg string `json:"msg"`
	}
	if err := json.Unmarshal(body, &payload); err == nil {
		if message := firstNonEmptyString(strings.TrimSpace(payload.Msg), strings.TrimSpace(payload.Error.Message)); message != "" {
			return message
		}
	}
	message := strings.TrimSpace(string(body))
	if message == "" {
		return "批量复刻任务执行失败"
	}
	if len(message) > 240 {
		message = message[:240]
	}
	return firstNonEmptyString(message, status)
}

func extractAestheticMirrorErrorMessage(value any) string {
	switch data := value.(type) {
	case map[string]any:
		if message, ok := data["message"].(string); ok {
			return strings.TrimSpace(message)
		}
	case string:
		return strings.TrimSpace(data)
	}
	return ""
}

func decodeAestheticMirrorDataURL(value string) ([]byte, string, error) {
	mimeType := "image/png"
	raw := value
	if comma := strings.Index(value, ","); strings.HasPrefix(value, "data:") && comma >= 0 {
		header := value[:comma]
		raw = value[comma+1:]
		if strings.HasPrefix(header, "data:") {
			mimeType = strings.TrimPrefix(strings.Split(header, ";")[0], "data:")
		}
	}
	data, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, "", err
	}
	return data, firstNonEmptyString(strings.TrimSpace(mimeType), strings.TrimSpace(http.DetectContentType(data))), nil
}

func normalizeAestheticMirrorBase64Image(value string, fallbackMime string) string {
	if strings.HasPrefix(value, "data:") {
		return value
	}
	return "data:" + firstNonEmptyString(strings.TrimSpace(fallbackMime), "image/png") + ";base64," + value
}

func downloadAestheticMirrorResultURL(ctx context.Context, value string) (string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, value, nil)
	if err != nil {
		return "", err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return "", safeMessageError{message: "读取生成结果失败"}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", safeMessageError{message: "读取生成结果失败"}
	}
	data, err := io.ReadAll(response.Body)
	if err != nil {
		return "", safeMessageError{message: "读取生成结果失败"}
	}
	mimeType := firstNonEmptyString(strings.TrimSpace(response.Header.Get("Content-Type")), strings.TrimSpace(http.DetectContentType(data)), "image/png")
	return "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(data), nil
}

func aestheticMirrorAPIMartResolutionForSize(size string) string {
	width, height, ok := parseAestheticMirrorPixelSize(size)
	if !ok {
		return "1k"
	}
	longSide := width
	if height > longSide {
		longSide = height
	}
	pixels := width * height
	if pixels >= 6000000 || longSide >= 2800 {
		return "4k"
	}
	if longSide >= 1800 {
		return "2k"
	}
	return "1k"
}

func parseAestheticMirrorPixelSize(size string) (int, int, bool) {
	parts := strings.Split(strings.ToLower(strings.TrimSpace(size)), "x")
	if len(parts) != 2 {
		return 0, 0, false
	}
	var width int
	var height int
	if _, err := fmt.Sscanf(strings.TrimSpace(parts[0]), "%d", &width); err != nil {
		return 0, 0, false
	}
	if _, err := fmt.Sscanf(strings.TrimSpace(parts[1]), "%d", &height); err != nil {
		return 0, 0, false
	}
	return width, height, width > 0 && height > 0
}

func aestheticMirrorLocalAPIURL(path string) string {
	return fmt.Sprintf("http://127.0.0.1:%s/api/v1%s", firstNonEmptyString(strings.TrimSpace(config.Cfg.Port), "18080"), path)
}

func chooseAestheticMirrorFilename(name string, mimeType string, isReference bool) string {
	trimmed := strings.TrimSpace(name)
	if trimmed != "" {
		if ext := filepath.Ext(trimmed); ext != "" {
			return trimmed
		}
		return trimmed + fileExtForAestheticMirrorMime(mimeType)
	}
	if isReference {
		return "reference" + fileExtForAestheticMirrorMime(mimeType)
	}
	return "product" + fileExtForAestheticMirrorMime(mimeType)
}

func fileExtForAestheticMirrorMime(mimeType string) string {
	switch strings.ToLower(strings.TrimSpace(mimeType)) {
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	default:
		return ".png"
	}
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func isValidAestheticMirrorImageInput(input AestheticMirrorJobImageInput) bool {
	return strings.TrimSpace(input.StorageKey) != "" || strings.TrimSpace(input.DataURL) != ""
}

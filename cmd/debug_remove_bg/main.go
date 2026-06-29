package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"strings"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
	"github.com/basketikun/infinite-canvas/service"
)

func main() {
	if len(os.Args) < 2 {
		panic("usage: debug_remove_bg <image-path>")
	}
	if err := config.Load(); err != nil {
		panic(err)
	}
	settings, err := repository.GetSettings()
	if err != nil {
		panic(err)
	}

	fmt.Println("public default image model:", settings.Public.ModelChannel.DefaultImageModel)
	fmt.Println("public available models:", strings.Join(settings.Public.ModelChannel.AvailableModels, ", "))
	fmt.Println("private channels:")
	for _, channel := range settings.Private.Channels {
		fmt.Printf("- %s enabled=%v base=%s models=%s\n", channel.Name, channel.Enabled, channel.BaseURL, strings.Join(channel.Models, ", "))
	}

	imagePath := os.Args[1]
	data, err := os.ReadFile(imagePath)
	if err != nil {
		panic(err)
	}

	if os.Getenv("REMOVE_BG_DEBUG_LOCAL") == "1" {
		localResult, err := service.RemoveBackground(context.Background(), imagePath, "image/jpeg", data)
		if err != nil {
			fmt.Println("local/default remove background error:", err)
		} else {
			if err := os.WriteFile("debug-remove-bg-default.png", localResult.Image, 0o644); err != nil {
				panic(err)
			}
			fmt.Println("wrote debug-remove-bg-default.png")
		}
	}

	modelName := strings.TrimSpace(settings.Public.ModelChannel.DefaultImageModel)
	if modelName == "" {
		modelName = "gpt-image-2"
	}
	channelID := ""
	for _, channel := range settings.Private.Channels {
		if !channel.Enabled {
			continue
		}
		for _, modelNameInChannel := range channel.Models {
			if strings.TrimSpace(modelNameInChannel) == modelName {
				channelID = channel.ID
				break
			}
		}
		if channelID != "" {
			break
		}
	}

	modelResult, err := service.RemoveBackground(context.Background(), imagePath, "image/jpeg", data, service.LayerImageOptions{
		Model:     modelName,
		ChannelID: channelID,
	})
	if err != nil {
		fmt.Println("image-model remove background error:", err)
		return
	}
	if err := os.WriteFile("debug-remove-bg-model.png", modelResult.Image, 0o644); err != nil {
		panic(err)
	}
	fmt.Println("wrote debug-remove-bg-model.png")

	if os.Getenv("REMOVE_BG_DEBUG_RAW") != "1" {
		return
	}

	rawTransparent, rawTransparentErr := requestRawImageEdit(context.Background(), modelName, imagePath, data, findChannel(settings.Private.Channels, channelID), true)
	if rawTransparentErr != nil {
		fmt.Println("raw transparent image-edit error:", rawTransparentErr)
	} else if err := os.WriteFile("debug-remove-bg-model-raw-transparent.png", rawTransparent, 0o644); err != nil {
		panic(err)
	} else {
		fmt.Println("wrote debug-remove-bg-model-raw-transparent.png")
	}

	rawPlain, rawPlainErr := requestRawImageEdit(context.Background(), modelName, imagePath, data, findChannel(settings.Private.Channels, channelID), false)
	if rawPlainErr != nil {
		fmt.Println("raw plain image-edit error:", rawPlainErr)
	} else if err := os.WriteFile("debug-remove-bg-model-raw-plain.png", rawPlain, 0o644); err != nil {
		panic(err)
	} else {
		fmt.Println("wrote debug-remove-bg-model-raw-plain.png")
	}
}

func findChannel(channels []model.ModelChannel, channelID string) model.ModelChannel {
	for _, channel := range channels {
		if channel.ID == channelID {
			return channel
		}
	}
	return model.ModelChannel{}
}

func requestRawImageEdit(ctx context.Context, modelName string, filename string, data []byte, channel model.ModelChannel, requestTransparentBackground bool) ([]byte, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	fields := map[string]string{
		"model":         modelName,
		"prompt":        "请做严格、通用的商品去背景抠图。只保留真实商品主体，删除所有背景、色块、白底、文案区、边框、场景和多余留白。不要重绘，不要美化，不要改文字。输出 PNG。",
		"output_format": "png",
	}
	if requestTransparentBackground {
		fields["background"] = "transparent"
	}
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			return nil, err
		}
	}
	part, err := writer.CreateFormFile("image", filename)
	if err != nil {
		return nil, err
	}
	if _, err := part.Write(data); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, service.BuildModelChannelURL(channel, "/images/edits"), bytes.NewReader(body.Bytes()))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+channel.APIKey)
	request.Header.Set("Content-Type", writer.FormDataContentType())

	response, err := service.HTTPClientForChannel(channel).Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	responseBody, _ := io.ReadAll(response.Body)
	if response.StatusCode >= http.StatusBadRequest {
		return nil, fmt.Errorf("status=%d body=%s", response.StatusCode, strings.TrimSpace(string(responseBody)))
	}
	return parseRawImageEdit(responseBody)
}

func parseRawImageEdit(body []byte) ([]byte, error) {
	var payload struct {
		Data []struct {
			B64JSON string `json:"b64_json"`
			URL     string `json:"url"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	for _, item := range payload.Data {
		if strings.TrimSpace(item.B64JSON) != "" {
			return base64.StdEncoding.DecodeString(stripDataURLPrefix(item.B64JSON))
		}
		if strings.TrimSpace(item.URL) != "" {
			response, err := http.Get(strings.TrimSpace(item.URL))
			if err != nil {
				return nil, err
			}
			defer response.Body.Close()
			return io.ReadAll(response.Body)
		}
	}
	return nil, fmt.Errorf("no image found")
}

func stripDataURLPrefix(value string) string {
	if comma := strings.Index(value, ","); strings.HasPrefix(value, "data:") && comma >= 0 {
		return value[comma+1:]
	}
	return value
}

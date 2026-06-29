package handler

import (
	"io"
	"net/http"
	"strings"

	"github.com/basketikun/infinite-canvas/service"
)

func RemoveBackground(w http.ResponseWriter, r *http.Request) {
	file, header, err := r.FormFile("file")
	if err != nil {
		Fail(w, "请选择要去背景的图片")
		return
	}
	defer file.Close()

	data, err := io.ReadAll(file)
	if err != nil {
		FailError(w, err)
		return
	}

	contentType := strings.TrimSpace(header.Header.Get("Content-Type"))
	if contentType == "" || !strings.HasPrefix(strings.ToLower(contentType), "image/") {
		contentType = http.DetectContentType(data)
	}

	result, err := service.RemoveBackground(r.Context(), header.Filename, contentType, data, service.LayerImageOptions{
		ChannelMode:   r.FormValue("channelMode"),
		Model:         r.FormValue("model"),
		TextModel:     r.FormValue("textModel"),
		ChannelID:     r.FormValue("channelId"),
		TextChannelID: r.FormValue("textChannelId"),
		BaseURL:       r.FormValue("baseUrl"),
		APIKey:        r.FormValue("apiKey"),
		TextBaseURL:   r.FormValue("textBaseUrl"),
		TextAPIKey:    r.FormValue("textApiKey"),
	})
	if err != nil {
		FailError(w, err)
		return
	}

	if strings.EqualFold(strings.TrimSpace(r.FormValue("response")), "json") || strings.Contains(strings.ToLower(r.Header.Get("Accept")), "application/json") {
		OK(w, map[string]any{
			"imageDataUrl":     pngDataURL(result.Image),
			"productDataUrl":   pngDataURL(result.Image),
			"originalWidth":    result.OriginalWidth,
			"originalHeight":   result.OriginalHeight,
			"productOffsetX":   result.ProductOffsetX,
			"productOffsetY":   result.ProductOffsetY,
			"productWidth":     result.ProductWidth,
			"productHeight":    result.ProductHeight,
			"product_url":      pngDataURL(result.Image),
			"original_width":   result.OriginalWidth,
			"original_height":  result.OriginalHeight,
			"product_offset_x": result.ProductOffsetX,
			"product_offset_y": result.ProductOffsetY,
			"product_width":    result.ProductWidth,
			"product_height":   result.ProductHeight,
		})
		return
	}

	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(result.Image)
}

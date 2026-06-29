package handler

import (
	"encoding/base64"
	"io"
	"net/http"
	"strings"

	"github.com/basketikun/infinite-canvas/service"
)

func LayerImage(w http.ResponseWriter, r *http.Request) {
	file, header, err := r.FormFile("file")
	if err != nil {
		Fail(w, "请选择要分层的图片")
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

	result, err := service.LayerImage(r.Context(), header.Filename, contentType, data, service.LayerImageOptions{
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

	textLayers := result.TextLayers
	if textLayers == nil {
		textLayers = []service.LayerImageTextLayer{}
	}

	OK(w, map[string]any{
		"backgroundDataUrl": pngDataURL(result.Background),
		"productDataUrl":    pngDataURL(result.Product),
		"textLayers":        textLayers,
		"originalWidth":     result.OriginalWidth,
		"originalHeight":    result.OriginalHeight,
		"productOffsetX":    result.ProductOffsetX,
		"productOffsetY":    result.ProductOffsetY,
		"productWidth":      result.ProductWidth,
		"productHeight":     result.ProductHeight,
	})
}

func pngDataURL(data []byte) string {
	if len(data) == 0 {
		return ""
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(data)
}

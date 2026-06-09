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
	if contentType == "" {
		contentType = http.DetectContentType(data)
	}

	result, err := service.RemoveBackground(r.Context(), header.Filename, contentType, data)
	if err != nil {
		FailError(w, err)
		return
	}

	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(result)
}

package service

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/basketikun/infinite-canvas/config"
	"github.com/google/uuid"
)

const MaxImageLinkBytes int64 = 30 * 1024 * 1024

type ImageLink struct {
	ID        string `json:"id"`
	URL       string `json:"url"`
	MimeType  string `json:"mimeType"`
	Bytes     int64  `json:"bytes"`
	CreatedBy string `json:"createdBy,omitempty"`
	CreatedAt string `json:"createdAt"`
}

type ImageLinkDownload struct {
	Link ImageLink
	Data []byte
}

func CreateImageLink(ctx context.Context, filename string, contentType string, data []byte) (ImageLink, error) {
	if len(data) == 0 {
		return ImageLink{}, errors.New("图片内容为空")
	}
	if int64(len(data)) > MaxImageLinkBytes {
		return ImageLink{}, errors.New("图片超过 30MB，无法生成链接")
	}
	contentType = normalizeImageLinkMimeType(contentType, filename, data)
	if !isAllowedImageLinkMimeType(contentType) {
		return ImageLink{}, errors.New("只支持 PNG、JPG、WEBP、GIF 图片")
	}
	if err := os.MkdirAll(imageLinkDir(), 0755); err != nil {
		return ImageLink{}, err
	}

	userID := "anonymous"
	if user, ok := UserFromContext(ctx); ok && strings.TrimSpace(user.ID) != "" {
		userID = user.ID
	}
	id := uuid.NewString()
	path := imageLinkPath(id, extensionForImageLinkMimeType(contentType))
	if err := os.WriteFile(path, data, 0644); err != nil {
		return ImageLink{}, err
	}
	return ImageLink{
		ID:        id,
		URL:       "/api/image-links/" + id,
		MimeType:  contentType,
		Bytes:     int64(len(data)),
		CreatedBy: userID,
		CreatedAt: now(),
	}, nil
}

func DownloadImageLink(id string) (ImageLinkDownload, error) {
	id = strings.TrimSpace(id)
	if _, err := uuid.Parse(id); err != nil {
		return ImageLinkDownload{}, errors.New("图片链接不存在")
	}
	matches, err := filepath.Glob(filepath.Join(imageLinkDir(), id+".*"))
	if err != nil || len(matches) == 0 {
		return ImageLinkDownload{}, errors.New("图片链接不存在")
	}
	path := matches[0]
	data, err := os.ReadFile(path)
	if err != nil {
		return ImageLinkDownload{}, err
	}
	mimeType := mimeTypeForImageLinkExtension(filepath.Ext(path))
	if mimeType == "" {
		mimeType = normalizeImageLinkMimeType("", path, data)
	}
	return ImageLinkDownload{
		Link: ImageLink{
			ID:        id,
			URL:       "/api/image-links/" + id,
			MimeType:  mimeType,
			Bytes:     int64(len(data)),
			CreatedAt: fileCreatedAt(path),
		},
		Data: data,
	}, nil
}

func imageLinkDir() string {
	baseDir := "data"
	if dsn := strings.TrimSpace(config.Cfg.DatabaseDSN); dsn != "" && dsn != ":memory:" {
		baseDir = filepath.Dir(dsn)
	}
	return filepath.Join(baseDir, "image-links")
}

func imageLinkPath(id string, ext string) string {
	return filepath.Join(imageLinkDir(), id+ext)
}

func normalizeImageLinkMimeType(contentType string, filename string, data []byte) string {
	value := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	if value == "" || value == "application/octet-stream" {
		value = strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(data), ";")[0]))
	}
	if value == "application/octet-stream" {
		value = mimeTypeForImageLinkExtension(filepath.Ext(filename))
	}
	return value
}

func isAllowedImageLinkMimeType(contentType string) bool {
	switch contentType {
	case "image/png", "image/jpeg", "image/webp", "image/gif":
		return true
	default:
		return false
	}
}

func extensionForImageLinkMimeType(contentType string) string {
	switch contentType {
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	default:
		return ".png"
	}
}

func mimeTypeForImageLinkExtension(ext string) string {
	switch strings.ToLower(ext) {
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".webp":
		return "image/webp"
	case ".gif":
		return "image/gif"
	case ".png":
		return "image/png"
	default:
		return ""
	}
}

func fileCreatedAt(path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return ""
	}
	return info.ModTime().UTC().Format(time.RFC3339)
}

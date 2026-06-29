package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	openapi "github.com/alibabacloud-go/darabonba-openapi/v2/client"
	ocr "github.com/alibabacloud-go/ocr-api-20210707/v3/client"
	util "github.com/alibabacloud-go/tea-utils/v2/service"
	"github.com/alibabacloud-go/tea/tea"
	"github.com/basketikun/infinite-canvas/config"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: go run ./cmd/debug_aliyun_ocr <image>")
		os.Exit(2)
	}
	if err := config.Load(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	client, err := ocr.NewClient(&openapi.Config{
		AccessKeyId:     tea.String(strings.TrimSpace(config.Cfg.AliyunImageSegAccessKeyID)),
		AccessKeySecret: tea.String(strings.TrimSpace(config.Cfg.AliyunImageSegAccessKeySecret)),
		Endpoint:        tea.String(strings.TrimSpace(config.Cfg.AliyunOCREndpoint)),
		Protocol:        tea.String("HTTPS"),
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	response, err := client.RecognizeAllTextWithOptions(&ocr.RecognizeAllTextRequest{
		Body:             bytes.NewReader(data),
		Type:             tea.String(strings.TrimSpace(config.Cfg.AliyunOCRType)),
		OutputCoordinate: tea.String("rectangle"),
		OutputOricoord:   tea.Bool(true),
	}, &util.RuntimeOptions{
		ConnectTimeout: tea.Int(10 * 1000),
		ReadTimeout:    tea.Int(20 * 1000),
		Autoretry:      tea.Bool(false),
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	type item struct {
		Text       string `json:"text"`
		Confidence int32  `json:"confidence"`
	}
	items := []item{}
	if response != nil && response.Body != nil && response.Body.Data != nil {
		for _, subImage := range response.Body.Data.SubImages {
			if subImage == nil || subImage.BlockInfo == nil {
				continue
			}
			for _, block := range subImage.BlockInfo.BlockDetails {
				if block == nil {
					continue
				}
				text := strings.TrimSpace(tea.StringValue(block.BlockContent))
				if text == "" {
					continue
				}
				items = append(items, item{Text: text, Confidence: tea.Int32Value(block.BlockConfidence)})
			}
		}
	}
	out, _ := json.MarshalIndent(map[string]any{
		"code":  tea.StringValue(response.Body.Code),
		"count": len(items),
		"items": items,
	}, "", "  ")
	fmt.Println(string(out))
}

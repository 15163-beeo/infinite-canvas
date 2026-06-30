package handler

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/basketikun/infinite-canvas/service"
)

func CreateAestheticMirrorJob(w http.ResponseWriter, r *http.Request) {
	var request service.AestheticMirrorJobCreateInput
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "批量复刻参数格式错误")
		return
	}
	token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	job, err := service.CreateAestheticMirrorJob(r.Context(), token, request)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, job)
}

func AestheticMirrorJob(w http.ResponseWriter, r *http.Request, id string) {
	job, err := service.GetAestheticMirrorJob(r.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "不存在") {
			FailStatus(w, http.StatusNotFound, err.Error())
			return
		}
		FailError(w, err)
		return
	}
	OK(w, job)
}

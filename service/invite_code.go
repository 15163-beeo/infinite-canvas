package service

import (
	"crypto/rand"
	"encoding/base32"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"github.com/basketikun/infinite-canvas/repository"
)

func ListInviteCodes(q model.Query) (model.InviteCodeList, error) {
	items, total, err := repository.ListInviteCodes(q)
	if err != nil {
		return model.InviteCodeList{}, err
	}
	return model.InviteCodeList{Items: items, Total: int(total)}, nil
}

func GenerateInviteCodes(createdBy string, count int, remark string) ([]model.InviteCode, error) {
	if count <= 0 {
		count = 1
	}
	if count > 50 {
		count = 50
	}
	nowValue := now()
	items := make([]model.InviteCode, 0, count)
	seen := map[string]struct{}{}
	for len(items) < count {
		code, err := newInviteCodeValue()
		if err != nil {
			return nil, err
		}
		if _, exists := seen[code]; exists {
			continue
		}
		if _, exists, err := repository.GetInviteCodeByCode(code); err != nil {
			return nil, err
		} else if exists {
			continue
		}
		seen[code] = struct{}{}
		items = append(items, model.InviteCode{
			ID:        newID("invite"),
			Code:      code,
			Status:    model.InviteCodeStatusUnused,
			CreatedBy: strings.TrimSpace(createdBy),
			Remark:    strings.TrimSpace(remark),
			CreatedAt: nowValue,
			UpdatedAt: nowValue,
		})
	}
	return items, repository.SaveInviteCodes(items)
}

func SetInviteCodeStatus(id string, status model.InviteCodeStatus) (model.InviteCode, error) {
	item, ok, err := repository.GetInviteCodeByID(id)
	if err != nil || !ok {
		if err != nil {
			return item, err
		}
		return item, safeMessageError{message: "邀请码不存在"}
	}
	if item.Status == model.InviteCodeStatusUsed {
		return item, safeMessageError{message: "已使用的邀请码不能再修改"}
	}
	if status != model.InviteCodeStatusUnused && status != model.InviteCodeStatusDisabled {
		return item, safeMessageError{message: "邀请码状态无效"}
	}
	item.Status = status
	item.UpdatedAt = now()
	return repository.SaveInviteCode(item)
}

func newInviteCodeValue() (string, error) {
	buf := make([]byte, 6)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	code := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(buf)
	code = strings.ToUpper(strings.TrimSpace(code))
	code = strings.ReplaceAll(code, "O", "8")
	code = strings.ReplaceAll(code, "I", "9")
	if len(code) > 10 {
		code = code[:10]
	}
	return code, nil
}

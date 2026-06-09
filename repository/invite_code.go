package repository

import (
	"errors"
	"strings"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

func ListInviteCodes(q model.Query) ([]model.InviteCode, int64, error) {
	db, err := DB()
	if err != nil {
		return nil, 0, err
	}
	q.Normalize()
	tx := db.Model(&model.InviteCode{})
	if keyword := strings.TrimSpace(q.Keyword); keyword != "" {
		like := "%" + keyword + "%"
		tx = tx.Where("code LIKE ? OR used_by_name LIKE ? OR remark LIKE ?", like, like, like)
	}

	var total int64
	if err := tx.Count(&total).Error; err != nil {
		return nil, 0, err
	}

	var items []model.InviteCode
	err = tx.Order("created_at desc").Offset(q.Offset()).Limit(q.PageSize).Find(&items).Error
	return items, total, err
}

func GetInviteCodeByID(id string) (model.InviteCode, bool, error) {
	db, err := DB()
	if err != nil {
		return model.InviteCode{}, false, err
	}
	return findInviteCode(db, "id = ?", id)
}

func GetInviteCodeByCode(code string) (model.InviteCode, bool, error) {
	db, err := DB()
	if err != nil {
		return model.InviteCode{}, false, err
	}
	return findInviteCode(db, "code = ?", strings.ToUpper(strings.TrimSpace(code)))
}

func SaveInviteCode(item model.InviteCode) (model.InviteCode, error) {
	db, err := DB()
	if err != nil {
		return item, err
	}
	return item, db.Save(&item).Error
}

func SaveInviteCodes(items []model.InviteCode) error {
	if len(items) == 0 {
		return nil
	}
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Create(&items).Error
}

func CreateUserWithInviteCode(user model.User, invite model.InviteCode) (model.User, error) {
	db, err := DB()
	if err != nil {
		return user, err
	}
	err = db.Transaction(func(tx *gorm.DB) error {
		var current model.InviteCode
		if err := tx.Where("id = ?", invite.ID).First(&current).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return errors.New("邀请码不存在")
			}
			return err
		}
		if current.Status != model.InviteCodeStatusUnused {
			return errors.New("邀请码不可用")
		}
		if err := tx.Create(&user).Error; err != nil {
			return err
		}
		current.Status = model.InviteCodeStatusUsed
		current.UsedByUserID = user.ID
		current.UsedByName = firstNonEmpty(strings.TrimSpace(user.DisplayName), strings.TrimSpace(user.Username))
		current.UsedAt = user.CreatedAt
		current.UpdatedAt = user.UpdatedAt
		return tx.Save(&current).Error
	})
	return user, err
}

func findInviteCode(db *gorm.DB, query string, args ...any) (model.InviteCode, bool, error) {
	item := model.InviteCode{}
	err := db.Where(query, args...).First(&item).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.InviteCode{}, false, nil
	}
	return item, err == nil, err
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

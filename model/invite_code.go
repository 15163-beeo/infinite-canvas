package model

type InviteCodeStatus string

const (
	InviteCodeStatusUnused   InviteCodeStatus = "unused"
	InviteCodeStatusUsed     InviteCodeStatus = "used"
	InviteCodeStatusDisabled InviteCodeStatus = "disabled"
)

// InviteCode 注册邀请码。
type InviteCode struct {
	ID           string           `json:"id" gorm:"primaryKey"`
	Code         string           `json:"code" gorm:"uniqueIndex"`
	Status       InviteCodeStatus `json:"status" gorm:"index"`
	CreatedBy    string           `json:"createdBy" gorm:"index"`
	UsedByUserID string           `json:"usedByUserId" gorm:"index"`
	UsedByName   string           `json:"usedByName"`
	UsedAt       string           `json:"usedAt"`
	Remark       string           `json:"remark"`
	CreatedAt    string           `json:"createdAt"`
	UpdatedAt    string           `json:"updatedAt"`
}

type InviteCodeList struct {
	Items []InviteCode `json:"items"`
	Total int          `json:"total"`
}

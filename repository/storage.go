package repository

import (
	"errors"

	"github.com/basketikun/infinite-canvas/model"
	"gorm.io/gorm"
)

func SaveStorageObject(object model.StorageObject) (model.StorageObject, error) {
	db, err := DB()
	if err != nil {
		return model.StorageObject{}, err
	}
	return object, db.Save(&object).Error
}

func GetStorageObject(id string) (model.StorageObject, error) {
	db, err := DB()
	if err != nil {
		return model.StorageObject{}, err
	}
	var object model.StorageObject
	err = db.First(&object, "id = ?", id).Error
	return object, err
}

func DeleteStorageObjectRecord(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.StorageObject{}, "id = ?", id).Error
}

func GetUserConfig(userID string) (model.UserConfig, bool, error) {
	db, err := DB()
	if err != nil {
		return model.UserConfig{}, false, err
	}
	var config model.UserConfig
	err = db.First(&config, "user_id = ?", userID).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return model.UserConfig{}, false, nil
		}
		return model.UserConfig{}, false, err
	}
	return config, true, nil
}

func SaveUserConfig(config model.UserConfig) (model.UserConfig, error) {
	db, err := DB()
	if err != nil {
		return config, err
	}
	return config, db.Save(&config).Error
}

func ListCreativeWorkflows(userID string) ([]model.CreativeWorkflow, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var workflows []model.CreativeWorkflow
	err = db.Where("scope = ? OR owner_user_id = ?", "public", userID).Order("updated_at DESC").Find(&workflows).Error
	return workflows, err
}

func GetCreativeWorkflow(id string) (model.CreativeWorkflow, bool, error) {
	db, err := DB()
	if err != nil {
		return model.CreativeWorkflow{}, false, err
	}
	var workflow model.CreativeWorkflow
	err = db.First(&workflow, "id = ?", id).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return model.CreativeWorkflow{}, false, nil
		}
		return model.CreativeWorkflow{}, false, err
	}
	return workflow, true, nil
}

func SaveCreativeWorkflow(workflow model.CreativeWorkflow) (model.CreativeWorkflow, error) {
	db, err := DB()
	if err != nil {
		return workflow, err
	}
	return workflow, db.Save(&workflow).Error
}

func DeleteCreativeWorkflow(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.CreativeWorkflow{}, "id = ?", id).Error
}

# 后端数据库说明

本文档只记录后端当前已经使用的主要数据表。

## 数据库

后端使用 GORM 管理数据库连接和表结构迁移。

支持的存储驱动：

- `sqlite`
- `mysql`
- `postgresql`

当前启动时执行 `AutoMigrate`，自动维护以下表：

- `users`
- `credit_logs`
- `prompts`
- `assets`
- `settings`
- `credit_logs`
- `storage_objects`
- `user_configs`
- `creative_workflows`

后续新增表时再同步补充本文档，未实际使用的规划表不提前写入。

### users

系统用户表。用户基础信息、角色、算力点余额和第三方登录标识放在该表中。

| 字段              | 类型     | 说明                       |
|-----------------|--------|--------------------------|
| `id`            | string | 主键                       |
| `username`      | string | 用户名，唯一索引                 |
| `password`      | string | 密码哈希                     |
| `email`         | string | 邮箱                       |
| `display_name`  | string | 昵称                       |
| `avatar_url`    | string | 头像地址                     |
| `role`          | string | 角色：`user`、`admin`        |
| `credits`       | number | 算力点余额                    |
| `aff_code`      | string | 用户自己的邀请码，唯一索引            |
| `aff_count`     | number | 已邀请用户数量，冗余统计字段           |
| `inviter_id`    | string | 邀请人用户 ID                 |
| `github_id`     | string | GitHub 用户 ID               |
| `linux_do_id`   | string | Linux.do 用户 ID            |
| `wechat_id`     | string | 微信用户 ID                   |
| `status`        | string | 用户状态：`active`、`ban`       |
| `last_login_at` | string | 最近登录时间                   |
| `extra`         | json   | 扩展信息，第三方资料按平台命名空间保存，如 `linuxDo` |
| `created_at`    | string | 创建时间                     |
| `updated_at`    | string | 更新时间                     |

### prompts

提示词表。用于保存公开提示词、内置 GitHub 系统提示词、分类和预览内容。

| 字段           | 类型     | 说明                           |
|--------------|--------|------------------------------|
| `id`         | string | 主键                           |
| `title`      | string | 标题                           |
| `cover_url`  | string | 封面图                          |
| `prompt`     | string | 提示词内容                        |
| `tags`       | json   | 标签列表                         |
| `category`   | string | 分类标识                         |
| `preview`    | text   | Markdown 展示内容，可包含文本、图片、视频链接等 |
| `created_at` | string | 创建时间                         |
| `updated_at` | string | 更新时间                         |

`github_url` 仅用于接口返回，不写入数据库。

### assets

素材表。当前用于后台素材库。

| 字段               | 类型     | 说明                            |
|------------------|--------|-------------------------------|
| `id`             | string | 主键                            |
| `title`          | string | 标题                            |
| `type`           | string | 素材类型：`text`、`image`、`video` 等 |
| `cover_url`      | string | 封面图                           |
| `tags`           | json   | 标签列表                          |
| `category`       | string | 分类标识                          |
| `description`    | string | 描述                            |
| `content`        | text   | 文本或 Markdown 内容               |
| `url`            | string | 图片、视频等媒体地址                    |
| `created_at`     | string | 创建时间                          |
| `updated_at`     | string | 更新时间                          |

### settings

系统配置表，只保存两行数据：`public` 放前端可读取的公开配置，`private` 放仅后端和管理员可读取的私有配置，配置值都用 JSON。

| 字段           | 类型     | 说明                    |
|--------------|--------|-----------------------|
| `key`        | string | 主键：`public`、`private` |
| `value`      | json   | 配置内容                  |
| `created_at` | string | 创建时间                  |
| `updated_at` | string | 更新时间                  |

`public.value` 常放前端展示和可公开读取的配置，例如模型列表、登录开关等。
`private.value` 常放渠道密钥、登录密钥、后台内部开关等。

当前系统设置接口会按后端结构体序列化和反序列化已知字段；数据库 JSON 中额外存在的旧字段会被忽略。

`public.value` 当前字段：

| 字段                | 类型       | 说明             |
|-------------------|----------|----------------|
| `modelChannel` | object | 模型渠道公开配置组 |
| `auth` | object | 公开登录配置 |

`modelChannel` 当前字段：

| 字段                | 类型       | 说明             |
|-------------------|----------|----------------|
| `availableModels` | string[] | 系统可用模型列表       |
| `modelCosts` | object[] | 模型算力点配置       |
| `channels` | object[] | 公开接口返回的脱敏渠道摘要，不包含 API Key |
| `defaultModel`    | string   | 默认模型           |
| `defaultImageModel` | string | 默认图片模型         |
| `defaultVideoModel` | string | 默认视频模型         |
| `defaultTextModel` | string  | 默认文本模型         |
| `systemPrompt`    | string   | 系统提示词          |
| `allowCustomChannel` | bool    | 是否允许用户自定义渠道，默认允许，关闭后前端只提供走后端渠道的模式 |

`modelCosts` 每项字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | string | 模型名称 |
| `credits` | number | 每次后端模型接口调用前预扣的算力点，未配置默认不扣除 |

`auth.linuxDo` 当前字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | bool | 是否开启 Linux.do 登录 |

`private.value` 当前字段：

| 字段         | 类型       | 说明       |
|------------|----------|----------|
| `channels` | object[] | 模型渠道配置列表 |
| `promptSync` | object | GitHub 远程提示词定时同步配置 |
| `auth` | object | 私有登录配置 |
| `storage` | object | 对象存储配置 |

`channels` 每项字段：

| 字段       | 类型       | 说明       |
|----------|----------|----------|
| `protocol` | string | 协议，当前支持 `openai` |
| `name`   | string   | 渠道名称     |
| `baseUrl` | string  | 渠道接口地址   |
| `apiKey` | string   | 渠道密钥     |
| `models` | string[] | 渠道可用模型列表 |
| `weight` | number   | 渠道权重，同一模型命中多个渠道时按权重随机 |
| `timeout` | number | 上游请求超时时间，单位秒，默认 600 |
| `enabled` | bool    | 是否启用     |
| `remark` | string   | 备注       |

`promptSync` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | bool | 是否开启定时同步，默认开启 |
| `cron` | string | Cron 表达式，默认每 5 分钟 |

`auth.linuxDo` 当前字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `clientId` | string | Linux.do OAuth App Client ID |
| `clientSecret` | string | Linux.do OAuth App Client Secret，后台返回时隐藏 |

后端请求模型时，先按模型名筛选启用且包含该模型的渠道，再按 `weight` 加权随机选择一个渠道。

`storage` 当前字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `mode` | string | 存储模式：`local_indexeddb`、`server_sqlite_s3`、`hybrid` |
| `allowUserProvider` | bool | 是否允许用户配置自己的 S3/R2 |
| `providers` | object[] | 管理员配置的 S3/R2 存储 |
| `roundRobinCursor` | number | 多存储轮询游标 |
| `capacityCheck` | object | 容量统计定时任务配置 |
| `capacityLimitBytes` | number | 单个存储容量上限，默认约 9 GiB |

### credit_logs

用户算力点变更流水表。当前记录后台手动调整、模型调用预扣和模型调用失败返还。

| 字段           | 类型     | 说明                       |
|--------------|--------|--------------------------|
| `id`         | string | 主键                       |
| `user_id`    | string | 关联用户 ID                  |
| `type`       | string | 类型：`admin_adjust`、`ai_consume`、`ai_refund` |
| `amount`     | number | 本次变动数量，增加为正，扣减为负         |
| `balance`    | number | 变动后的用户算力点余额              |
| `related_id` | string | 关联业务 ID，可为空                |
| `remark`     | string | 备注                       |
| `extra`      | json   | 扩展信息                     |
| `created_at` | string | 创建时间                     |

`type` 当前取值：

| 值 | 说明 |
| --- | --- |
| `admin_adjust` | 后台手动调整 |
| `ai_consume` | 调用后端模型接口消费 |
| `ai_refund` | 后端模型接口调用失败返还 |

### storage_objects

对象存储文件索引表。图片文件写入服务端存储时，SQLite 保存文件元数据，真实文件保存在 S3/R2。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键，也是前端 `server:{id}` 中的对象 ID |
| `provider_id` | string | 写入时使用的存储配置 ID |
| `bucket` | string | 存储桶 |
| `object_key` | string | S3/R2 对象 Key，唯一索引 |
| `public_url` | string | 公开访问地址 |
| `mime_type` | string | 文件 MIME |
| `bytes` | number | 文件大小 |
| `width` | number | 图片宽度 |
| `height` | number | 图片高度 |
| `sha256` | string | 文件哈希 |
| `created_by` | string | 创建用户 ID |
| `created_at` | string | 创建时间 |
| `deleted_at` | string | 删除时间；当前删除文件时会直接删除记录 |

### user_configs

用户配置表。用于把用户模型配置、用户 S3/R2 配置、画布数据和生图历史跟随账号同步。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `user_id` | string | 主键，用户 ID |
| `model_config` | text | 用户同步的本地直连模型配置 JSON |
| `storage_provider` | text | 用户自定义 S3/R2 配置 JSON |
| `canvas_data` | text | 用户画布数据快照 JSON |
| `image_history` | text | 用户生图历史和分类快照 JSON |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |

### creative_workflows

创作工作流模板表。工作流主体数据保存在 `data` JSON 中，外层字段用于查询和权限判断。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键 |
| `owner_user_id` | string | 创建者用户 ID |
| `scope` | string | `private` 或 `public` |
| `name` | string | 工作流名称 |
| `category` | string | 分类 |
| `description` | string | 描述 |
| `data` | text | 完整工作流 JSON，包含变量、提示词模板和生图配置 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |
| `last_run_at` | string | 最近运行时间 |

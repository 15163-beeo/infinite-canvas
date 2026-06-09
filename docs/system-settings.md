# 系统配置数据结构

系统配置保存在 `settings` 表中，目前只使用两行：

| key | 说明 |
| --- | --- |
| `public` | 公开配置，前端可以读取 |
| `private` | 私有配置，只给后端和管理员使用 |

## public.value

```json
{
  "modelChannel": {
    "availableModels": ["gpt-5.5", "gpt-image-2"],
    "modelCosts": [
      { "model": "gpt-5.5", "credits": 1 },
      { "model": "gpt-image-2", "credits": 10 }
    ],
    "defaultModel": "gpt-image-2",
    "defaultImageModel": "gpt-image-2",
    "defaultTextModel": "gpt-5.5",
    "systemPrompt": "",
    "allowCustomChannel": true
  },
  "auth": {
    "allowRegister": true,
    "linuxDo": {
      "enabled": false
    }
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `modelChannel` | object | 模型渠道公开配置组 |
| `auth` | object | 认证相关公开配置 |

`modelChannel` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `availableModels` | string[] | 系统可用模型，由管理员手动选择；页面下拉选项可来自私有渠道模型 |
| `channels` | object[] | 已启用私有渠道的脱敏摘要，供前端展示渠道名称、地址和模型数量，不包含 API Key |
| `modelCosts` | object[] | 模型算力点配置，后端模型接口调用前按模型预扣，上游失败时返还；未配置默认不扣除 |
| `defaultModel` | string | 默认模型，从 `availableModels` 中选择 |
| `defaultImageModel` | string | 默认图片模型，从 `availableModels` 中选择 |
| `defaultTextModel` | string | 默认文本模型，从 `availableModels` 中选择 |
| `systemPrompt` | string | 系统提示词 |
| `allowCustomChannel` | boolean | 是否允许用户在配置弹窗中切换为本地直连渠道，默认允许 |

`modelCosts` 每项字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | string | 模型名称 |
| `credits` | number | 每次后端模型接口调用前预扣的算力点 |

用户侧请求模式：

| 模式 | 说明 |
| --- | --- |
| 云端渠道 | 使用后端 `/api/v1/*` 代理接口，请求会按模型名匹配 `private.value.channels` 中的可用渠道 |
| 本地直连 | 默认可选；`allowCustomChannel` 关闭后不可选，用户在浏览器本地配置 `baseUrl`、`apiKey` 和模型列表后直接请求模型接口 |

`auth` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `allowRegister` | boolean | 是否允许用户注册，默认允许；关闭后注册入口隐藏，注册接口拒绝新用户创建 |
| `linuxDo.enabled` | boolean | 是否开启 Linux.do 登录 |

## private.value

```json
{
  "channels": [
    {
      "protocol": "openai",
      "name": "默认渠道",
      "baseUrl": "https://api.example.com",
      "apiKey": "sk-xxx",
      "models": ["gpt-5.5", "gpt-image-2"],
      "weight": 1,
      "timeout": 600,
      "enabled": true,
      "remark": ""
    }
  ],
  "promptSync": {
    "enabled": true,
    "cron": "*/5 * * * *"
  },
  "storage": {
    "mode": "local_indexeddb",
    "allowUserProvider": true,
    "providers": [],
    "capacityCheck": {
      "enabled": true,
      "cron": "0 */6 * * *"
    },
    "capacityLimitBytes": 9663676416
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `channels` | object[] | 模型渠道列表 |
| `promptSync` | object | GitHub 远程提示词定时同步配置 |
| `storage` | object | 文件存储配置，控制 IndexedDB、SQLite + S3/R2 和用户自定义对象存储 |

`channels` 每项字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `protocol` | string | 协议，当前为 `openai` |
| `name` | string | 渠道名称 |
| `baseUrl` | string | OpenAI 兼容接口地址 |
| `apiKey` | string | 渠道密钥 |
| `models` | string[] | 该渠道可用模型 |
| `weight` | number | 渠道权重；同一模型有多个可用渠道时按权重随机 |
| `timeout` | number | 上游请求超时时间，单位秒，默认 600 |
| `enabled` | boolean | 是否启用 |
| `remark` | string | 备注 |

后端调用模型时，会从已启用、已配置 `baseUrl` 和 `apiKey`、且 `models` 包含目标模型的渠道中选择一个。后端代理支持 OpenAI 兼容的 `/v1/images/*`、`/v1/responses`、`/v1/chat/completions` 和视频相关路径。

`storage` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `mode` | string | 存储模式：`local_indexeddb`、`server_sqlite_s3`、`hybrid` |
| `allowUserProvider` | boolean | 是否允许用户配置自己的 S3/R2 对象存储 |
| `providers` | object[] | 管理员配置的 S3/R2 存储列表 |
| `roundRobinCursor` | number | 多个启用存储的轮询游标 |
| `capacityCheck.enabled` | boolean | 是否定时统计启用存储的容量 |
| `capacityCheck.cron` | string | 容量统计 Cron 表达式 |
| `capacityLimitBytes` | number | 单个存储到达该容量后禁用，默认约 9 GiB |

`storage.providers` 每项字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 配置 ID |
| `name` | string | 显示名称 |
| `type` | string | 当前为 `s3` |
| `endpoint` | string | S3/R2 Endpoint |
| `region` | string | 区域，Cloudflare R2 通常为 `auto` |
| `bucket` | string | 存储桶名称 |
| `accessKeyId` | string | Access Key ID |
| `secretAccessKey` | string | Secret Access Key，后台返回时隐藏 |
| `publicBaseUrl` | string | 公开访问域名，例如 R2 public bucket URL |
| `pathPrefix` | string | 对象 Key 前缀 |
| `weight` | number | 多存储轮询权重 |
| `enabled` | boolean | 是否启用 |
| `capacityBytes` | number | 最近一次统计的容量 |
| `capacityCheckedAt` | string | 最近一次容量统计时间 |
| `capacityExceeded` | boolean | 是否超过容量限制 |

`promptSync` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | boolean | 是否开启定时同步，默认开启 |
| `cron` | string | Cron 表达式，默认每 5 分钟 |

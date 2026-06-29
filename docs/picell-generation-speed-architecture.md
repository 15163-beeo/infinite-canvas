# Picell 生图速度与架构分析

记录时间：2026-06-13

## 结论

Picell 不是前端直接把图片二进制发给模型接口，然后傻等 `/images/edits` 返回。它的核心是：

1. 参考图先上传到对象存储。
2. 前端创建一个异步生图任务。
3. 后端 Worker 调 AI 上游。
4. 生成结果保存到对象存储/CDN。
5. 前端监听或轮询任务状态，成功后加载 CDN 图片。

实测这次 `GPT Image 2` 图生图并不是秒出：从创建任务到 `generation_jobs=success` 大约 67 秒。但它比我们之前 ZLYBK 5-9 分钟稳定很多，原因主要是更好的上游路由/队列 + 对象存储 + 异步任务架构。

## 实测证据

本次在 Picell 画布页触发一次真实图生图任务，模型为 `gpt-image-2`，模式为快速，2 张参考图。

关键时间线：

| 时间 | 事件 |
| --- | --- |
| 03:22:10 | `POST /supabase/functions/v1/generate-image` 返回 `job_id` |
| 03:22:10 | 第一次查询 `generation_jobs`，状态为 `processing` |
| 03:23:12 | 结果图写入 OSS/CDN，响应头 `Last-Modified` 显示这个时间 |
| 03:23:17 | `generation_jobs` 状态变为 `success` |
| 03:23:23 | 浏览器加载最终 CDN 图片 |

创建任务请求体的特点：

```json
{
  "model": "gpt-image-2",
  "aspectRatio": "1:1",
  "imageSize": "1K",
  "gpt_quality": "auto",
  "imageCount": 1,
  "turboEnabled": false,
  "speedMode": "fast",
  "jobType": "CANVAS_IMAGE_GEN",
  "referenceImages": [
    "temp/<user-id>/<timestamp>_canvas-direct.png",
    "temp/<user-id>/<timestamp>_canvas-direct.png"
  ]
}
```

这个请求只有约 1.2KB，里面没有图片二进制，也没有 base64。参考图只是对象存储里的路径。

成功任务返回的结果数据包含：

```json
{
  "status": "success",
  "result_url": "https://cdn-01.picell.ai/generations/<user-id>/<timestamp>_<hash>.png",
  "result_data": {
    "endpoint": "/v1/images/edits",
    "actual_size": "1254x1254",
    "thumbnail_url": "https://cdn-01.picell.ai/generations/<user-id>/<timestamp>_<hash>_thumb.webp",
    "image_mime_type": "image/png",
    "routing_version": "v2",
    "reference_image_count": 2
  }
}
```

注意：`result_data.endpoint` 显示它后端实际也是走 `/v1/images/edits`，不是神秘的新接口。它快的关键不只是接口名，而是后端路由、队列和存储方式。

## Picell 用到的服务

### 1. 前端画布

负责上传图片、管理画布节点、创建生图任务、展示任务进度和最终结果。

### 2. Supabase Auth

负责登录态、用户身份和请求鉴权。

### 3. Supabase Functions

Picell 前端调用的核心函数包括：

- `get-oss-sts`：获取对象存储临时上传凭证。
- `generate-image`：创建异步生图任务。
- 其他功能函数：去背景、智能分层、审核等。

### 4. Supabase Postgres / REST

用于存任务、项目、用户积分和系统配置。

关键表类似：

- `generation_jobs`
- `projects`
- `profiles`
- `system_config`
- `canvas_project_snapshots`

### 5. Supabase Realtime

前端会尝试订阅 `generation_jobs` 表更新。

但这次实测控制台显示：

```text
Realtime channel closed for job ... polling continues as fallback
```

说明它不是完全靠流式，也不是完全靠 WebSocket。Realtime 断了以后会自动轮询。

### 6. 阿里云 OSS + CDN

Picell 当前公开配置显示：

```text
oss_enabled=true
oss_bucket=picset-ai-prod
oss_endpoint=oss-us-west-1.aliyuncs.com
oss_cdn_enabled=true
oss_cdn_domain=https://cdn-01.picell.ai/
```

作用：

- 存参考图。
- 存生成结果图。
- 存缩略图。
- 让前端通过 CDN 快速加载图片。

### 7. AI 上游渠道

后端 Worker 最终还是调用图片模型上游，例如 `/v1/images/edits`。

Picell 的结果里有 `routing_version: v2`，说明它内部有自己的渠道路由逻辑，可能按模型、速度模式、失败率、队列压力选择不同上游。

## Picell 完整流程

### 阶段 1：参考图上传

```text
用户上传/选择图片
  -> 前端调用 get-oss-sts
  -> 前端拿临时凭证
  -> 前端 PUT 图片到 OSS
  -> 前端得到对象路径 temp/<user-id>/<timestamp>_canvas-direct.png
  -> 画布里引用这个对象路径
```

这一步的价值：

- 不把大图片塞进每次生图请求。
- 后端可以直接根据路径读取原图。
- 图片可以跨电脑、跨会话复用。

### 阶段 2：创建生图任务

```text
用户点击发送
  -> POST /functions/v1/generate-image
  -> 请求体包含 prompt、model、size、speedMode、referenceImages
  -> 后端创建 generation_jobs 记录
  -> 立即返回 job_id
```

这里前端不会等待模型生成完成，只拿 `job_id`。

### 阶段 3：后端 Worker 执行任务

```text
generation_jobs.status = pending
  -> Worker 领取任务
  -> status = processing
  -> 根据 model + speedMode 选择上游渠道
  -> 读取 OSS 里的参考图
  -> 调用 AI 上游 /v1/images/edits
  -> 拿到结果图
  -> 保存结果图到 OSS/CDN
  -> 生成缩略图
  -> 更新 generation_jobs.status = success
  -> 写入 result_url/result_data
```

这一步是真正耗时的地方。

### 阶段 4：前端等待任务结果

```text
前端拿 job_id
  -> 优先订阅 generation_jobs 的 UPDATE
  -> 如果 Realtime 不可用，切换轮询
  -> 轮询 GET /generation_jobs?id=eq.<job_id>
  -> status=processing 时继续等待
  -> status=success 时读取 result_url
  -> 加载 CDN 图片并放到画布
  -> status=failed 时显示错误和重试
```

### 阶段 5：结果展示和持久化

```text
result_url = CDN 图片地址
  -> 前端直接加载图片
  -> 项目快照保存 result_url / object path
  -> 下次打开画布可以恢复
```

## 为什么 Picell 看起来更快

### 1. 前端请求很小

Picell 创建任务请求约 1.2KB，只传路径。我们现在的 `/images/edits` 请求会传 multipart 图片文件。

这能减少：

- 浏览器上传耗时。
- 后端读请求体耗时。
- 代理转发大图片的失败概率。
- base64 膨胀。

不过从我们服务器日志看，当前最慢不是上传，而是上游等待。

### 2. 异步任务避免单个 HTTP 长连接

Picell 不让浏览器等一个 5 分钟 HTTP 请求。前端拿 `job_id` 后只轮询状态。

好处：

- 页面不会像卡死一样。
- 刷新后可恢复任务。
- 后端可以做重试。
- 可以记录每个阶段耗时。
- 可以统一处理失败、退款、重试。

### 3. 结果走 CDN，不走大 JSON

Picell 结果是 `result_url`，浏览器直接 GET CDN 图片。不是把 1-10MB base64 放在 API JSON 里返回。

好处：

- 响应更小。
- 图片可缓存。
- 跨设备可访问。
- 素材库可以复用同一个 URL。

### 4. 有速度模式和路由

请求里有：

```json
{
  "speedMode": "fast",
  "turboEnabled": false,
  "routing_version": "v2"
}
```

这说明 Picell 后端不是固定一个 key 调到底，而是有渠道路由。它可能按：

- 模型类型
- 快速/普通/高质量
- 上游健康度
- 最近耗时
- 失败率
- 队列压力

选择不同渠道。

### 5. 图片已经在对象存储里

参考图已经是服务端可访问 URL/path，上游如果支持图片 URL 输入，就不需要反复传大文件。如果上游只支持 multipart，后端也可以从 OSS 拉取后再传，不影响前端体验。

## 和我们当前项目的区别

### 我们当前链路

```text
前端画布
  -> imageToDataUrl / File
  -> FormData multipart
  -> POST /api/v1/images/edits
  -> Go 后端代理
  -> 选中一个模型渠道
  -> 同步等待上游返回
  -> 上游返回 JSON/base64
  -> 前端解析并保存
```

特点：

- 请求是同步阻塞。
- 上游慢，页面就一直等。
- 失败后用户体验差。
- 不容易恢复任务。
- 结果没有天然 CDN URL。

### 服务器日志证据

近期日志：

```text
endpoint=/images/edits model=gpt-image-2 channel=ZLYBK Edit
requestReadMs=1 upstreamWaitMs=215400 responseCopyMs=3469 totalMs=218872

endpoint=/images/edits model=gpt-image-2 channel=ZLYBK Edit
requestReadMs=2 upstreamWaitMs=88843 responseCopyMs=3397 totalMs=92246
```

这说明：

- 前端上传到后端不是瓶颈。
- 后端读请求体不是瓶颈。
- 最大耗时是 `upstreamWaitMs`。
- 也就是上游渠道排队或生成慢。

## 我们要抄 Picell，推荐架构

### 最小可用版

```text
前端画布
  -> POST /api/v1/generation-jobs
  -> 后端创建 job
  -> 后台 goroutine 调现有 /images/edits
  -> 前端轮询 GET /api/v1/generation-jobs/:id
  -> 成功后显示结果
```

这个版本不一定立刻接 R2，先解决“长请求卡死”和“状态不可见”。

优点：

- 改动小。
- 能马上看到任务状态。
- 能记录每个任务真实耗时。
- 可以失败重试。

缺点：

- 图片还可能是本地或 base64。
- 跨设备素材问题没有彻底解决。
- 传图方式还没完全优化。

### 接近 Picell 版

```text
前端上传参考图
  -> 后端/R2 保存图片
  -> 返回 file_id + public_url/object_key
  -> 创建 generation job
  -> Worker 调 AI 上游
  -> 结果保存到 R2
  -> 更新 job.result_url
  -> 前端轮询并加载 result_url
```

推荐第三方服务：

- Cloudflare R2：存参考图和结果图。
- 现有服务器：跑 API 和 Worker。
- 现有 SQLite/Postgres：存任务表。
- 多个 AI 上游渠道：做速度路由。

不强制需要：

- Supabase
- Redis
- 独立 MQ
- Kubernetes
- 单独 CDN

### 商业增强版

```text
API Server
  -> Job DB
  -> Redis Queue
  -> 多 Worker
  -> Channel Router
  -> R2/S3/OSS
  -> Metrics/Logs
```

增强能力：

- 多 Worker 并发。
- 队列限流。
- 渠道熔断。
- 自动降权慢渠道。
- 用户取消任务。
- 失败自动退款。
- 任务恢复。
- 成本和耗时统计。

## 建议接口设计

### 上传文件

```http
POST /api/v1/files/upload
Content-Type: multipart/form-data
```

返回：

```json
{
  "fileId": "file_xxx",
  "objectKey": "images/<user-id>/<file-id>.png",
  "url": "https://<cdn-domain>/images/<user-id>/<file-id>.png",
  "width": 1200,
  "height": 1200,
  "mimeType": "image/png",
  "bytes": 1234567
}
```

### 创建生图任务

```http
POST /api/v1/generation-jobs
Content-Type: application/json
```

请求：

```json
{
  "projectId": "project_xxx",
  "mode": "edit",
  "model": "gpt-image-2",
  "speedMode": "fast",
  "prompt": "把图1中的产品替换为图2产品...",
  "referenceFileIds": ["file_1", "file_2"],
  "size": "1024x1024",
  "quality": "auto",
  "channelId": "auto"
}
```

返回：

```json
{
  "jobId": "job_xxx",
  "status": "pending"
}
```

### 查询任务

```http
GET /api/v1/generation-jobs/job_xxx
```

返回：

```json
{
  "jobId": "job_xxx",
  "status": "success",
  "resultUrl": "https://<cdn-domain>/generations/<user-id>/<job-id>.png",
  "thumbnailUrl": "https://<cdn-domain>/generations/<user-id>/<job-id>_thumb.webp",
  "errorMessage": "",
  "timings": {
    "queueWaitMs": 1200,
    "upstreamWaitMs": 67000,
    "saveResultMs": 800,
    "totalMs": 70000
  }
}
```

## 建议数据表

```sql
CREATE TABLE generation_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT,
  mode TEXT NOT NULL,
  model TEXT NOT NULL,
  speed_mode TEXT,
  prompt TEXT NOT NULL,
  reference_files_json TEXT,
  channel_id TEXT,
  status TEXT NOT NULL,
  result_url TEXT,
  thumbnail_url TEXT,
  result_file_id TEXT,
  error_message TEXT,
  error_code TEXT,
  queue_wait_ms INTEGER,
  upstream_wait_ms INTEGER,
  save_result_ms INTEGER,
  total_ms INTEGER,
  retry_count INTEGER DEFAULT 0,
  created_at DATETIME NOT NULL,
  started_at DATETIME,
  finished_at DATETIME
);
```

状态建议：

```text
pending
running
uploading_result
success
failed
cancelled
```

## 渠道路由建议

第一版可以很简单：

```text
如果用户指定 channelId，就用指定渠道。
否则按最近 20 次平均耗时排序，选最快可用渠道。
如果某渠道连续失败 3 次，临时降权 10 分钟。
如果任务超过超时时间，记录失败并允许重试到另一个渠道。
```

需要记录：

- `model`
- `channel_id`
- `endpoint`
- `status`
- `upstream_wait_ms`
- `response_bytes`
- `error_message`
- `created_at`

这样才能知道哪个渠道真的快。

## 分阶段落地计划

### 第一阶段：异步任务

目标：先解决页面长时间卡住。

改动：

- 新增 `generation_jobs` 表。
- 新增创建任务接口。
- 新增任务查询接口。
- 后端用 goroutine/worker 调现有 `/images/edits`。
- 前端改成提交任务后轮询。

预估：0.5-1 天。

### 第二阶段：R2/S3 存图

目标：输入图和结果图都持久化。

改动：

- 接 Cloudflare R2。
- 上传参考图返回 `fileId/url/objectKey`。
- Worker 使用文件 URL 或从 R2 拉取图片。
- 结果图保存到 R2。
- 画布节点保存 `fileId/resultUrl`。

预估：1-2 天。

### 第三阶段：渠道测速和自动路由

目标：让系统自动选更快渠道。

改动：

- 每次任务记录渠道耗时和失败率。
- 后台维护渠道健康度。
- `channelId=auto` 时选最快。
- 慢渠道降权。

预估：0.5-1 天。

### 第四阶段：体验增强

目标：接近 Picell 的用户体验。

改动：

- 任务可恢复。
- 失败可一键重试。
- 支持取消任务。
- 生成中展示已等待时间。
- 后台可查看每个渠道耗时。
- 缩略图生成。

预估：1-2 天。

## 风险和注意点

### 1. 异步架构不能解决上游本身慢

如果 ZLYBK 上游真实生成就是 5 分钟，异步任务只能让页面不卡，不能把 5 分钟变成 30 秒。

真正提速需要：

- 更快上游。
- 多个独立渠道。
- 快速队列。
- 模型/尺寸/质量降级。

### 2. 上游是否支持图片 URL 很关键

如果上游支持 URL 输入，R2/OSS 价值最大。

如果上游只支持 multipart，后端仍需要从 R2 下载图片再传给上游。这样前端体验会变好，但上游等待时间不一定减少。

### 3. 不要把 R2/S3 密钥放前端

正确做法：

- 前端上传到我们后端，再由后端上传 R2。
- 或后端发临时签名上传 URL。

不能把永久 `access key` 放浏览器。

### 4. 需要处理费用和退款

异步任务里要明确：

- 什么时候扣积分。
- 失败是否退款。
- 重试是否重复扣费。
- 用户刷新页面后任务怎么算。

### 5. 要有超时策略

建议：

```text
普通图生图：180 秒软超时
复杂编辑：300 秒软超时
超过软超时：前端提示仍在生成，可继续等待
超过硬超时：任务 failed，可重试
```

## 最推荐的实现路线

当前项目最现实的路线：

```text
第一步：异步 generation_jobs
第二步：Cloudflare R2 保存结果图
第三步：参考图也走 R2
第四步：多渠道测速和 auto routing
```

不要一开始就照搬 Supabase 全家桶。我们现有 Go 后端和数据库已经够用，先用自己的服务实现 Picell 的关键能力即可。

最终目标：

```text
用户点击生成
  -> 立即出现任务卡片
  -> 显示已等待时间
  -> 后台慢慢跑
  -> 成功后自动把 CDN 图片放进画布
  -> 刷新页面也能恢复
  -> 慢渠道自动降权
```

这才是 Picell 体验好的核心。

# Picell 去除背景功能复核与本项目实现方案

记录时间：2026-06-10

## 最终结论

Picell 的“去除背景”不是前端本地抠图，也不是前端直接把 prompt、模型名、透明参数传给图片模型。前端只上传图片，调用一个私有 Supabase Edge Function 创建异步任务，然后轮询任务表。服务端返回的是已经裁剪好的透明主体 PNG 和主体 bbox 元数据。

所以要对标它，重点不是在画布前端写复杂算法，而是把我们的后端做成同样的输出契约：

- 输入：原图。
- 输出：透明主体 PNG。
- 元数据：原图宽高、主体 bbox、主体偏移。
- 前端：只负责把透明 PNG 放到源图旁边，不显示 prompt 框，不参与抠图。

## 抓包证据

点击 Picell 画布工具条的“去除背景”后，请求链路如下。

### 1. 原图先上传到 OSS

前端会先获取 OSS 临时凭证，然后把画布里的图片上传到 `temp/<user-id>/<timestamp>_canvas-direct.png`。

相关请求：

```http
POST /supabase/functions/v1/get-oss-sts
PUT https://picset-ai-prod.oss-us-west-1.aliyuncs.com/temp/.../canvas-direct.png
GET https://cdn-01.picell.ai/temp/.../canvas-direct.png
```

这一步的目的不是抠图，只是把输入图变成服务端可访问的相对路径。

### 2. 创建去背景任务

```http
POST https://picell.ai/supabase/functions/v1/remove-bg
Content-Type: application/json
```

请求体只有图片路径和项目 ID：

```json
{
  "image": "temp/<user-id>/1781057000063_canvas-direct.png",
  "image_url": "temp/<user-id>/1781057000063_canvas-direct.png",
  "project_id": "<project-id>"
}
```

响应只返回任务 ID：

```json
{
  "status": "success",
  "job_id": "04206c75-0fc6-4ea7-bbcc-54b16a71b509"
}
```

这里没有 prompt、model、mask、alpha、background、transparent 等字段。

### 3. 轮询 generation_jobs

```http
GET /supabase/rest/v1/generation_jobs?select=id,type,status,result_url,result_data,error_message&id=eq.<job_id>
```

处理中响应：

```json
{
  "type": "REMOVE_BG",
  "status": "processing",
  "result_url": null,
  "result_data": null
}
```

成功响应：

```json
{
  "type": "REMOVE_BG",
  "status": "success",
  "result_url": "layers/<user-id>/1781062544_dacb92c4.png",
  "result_data": {
    "product_url": "layers/<user-id>/1781062544_dacb92c4.png",
    "product_width": 634,
    "product_height": 966,
    "original_width": 1200,
    "original_height": 1200,
    "product_offset_x": 566,
    "product_offset_y": 43
  },
  "error_message": null
}
```

### 4. 前端加载结果 PNG

```http
GET https://cdn-01.picell.ai/layers/<user-id>/1781062544_dacb92c4.png
```

这张结果图的实测属性：

- PNG RGBA。
- 尺寸：`634x966`。
- 四角 alpha：`0, 0, 0, 0`。
- `result_data.product_width/product_height` 与 PNG 尺寸一致。
- `original_width/original_height/product_offset_x/product_offset_y` 用于还原主体在原图中的位置。

## 速度观察

第一次抓到的同一任务时间线：

- `03:35:39`：`remove-bg` 返回 job_id。
- `03:35:44`：结果 PNG 的 `Last-Modified` 时间。
- `03:35:49`：轮询拿到 `status=success`。

用户要求重新点击后，又复核了一次同一个按钮的真实链路：

- `06:39:10`：`remove-bg` 返回 job_id：`ba4cc2c0-8b93-4dcb-b798-95cbca2b4e7e`。
- `06:39:11`：第一次轮询，`status=processing`。
- `06:39:17`：结果 PNG 的 `Last-Modified` 时间。
- `06:39:21`：轮询拿到 `status=success`。
- `06:39:23`：前端加载 CDN PNG。

第二次请求体仍然只有：

```json
{
  "image": "temp/<user-id>/1781057000063_canvas-direct.png",
  "image_url": "temp/<user-id>/1781057000063_canvas-direct.png",
  "project_id": "<project-id>"
}
```

第二次结果仍然是：

```json
{
  "product_url": "layers/<user-id>/1781073557_66b2fa43.png",
  "product_width": 634,
  "product_height": 966,
  "original_width": 1200,
  "original_height": 1200,
  "product_offset_x": 566,
  "product_offset_y": 43
}
```

第二次下载的 PNG 实测同样是 `634x966` RGBA，四角 alpha 全 0。

也就是说，结果文件大约 5-7 秒生成出来，前端约 10-13 秒内确认成功。它快的主要原因是：

- 前端不等待同步 HTTP 长连接生成图片，只创建任务并轮询。
- 后端不跑多轮失败重试。
- 返回的是裁剪后的主体小 PNG，不是整张 1200x1200 大图。
- 服务端很可能有专门的图像处理 pipeline，而不是把所有事情交给前端。

## 前端 bundle 证据

下载并检查 `https://picell.ai/assets/index-ZLTKU8QR.js` 后，能看到下面这些行为。

请求体构造函数：

```js
function oV(e,t){return{image:e,image_url:e,...t?{project_id:t}:{}}}
```

去背景调用：

```js
dt.functions.invoke("remove-bg", { body: oV(imagePath, projectId) })
```

成功后：

```js
q.status === "success" && q.result_data?.product_url
```

然后前端把 `product_url` 转成 CDN URL，使用 Fabric `Image.fromURL` 加到画布旁边，并建立源图到结果图的连接。

前端 bundle 里没有发现去背景 prompt、模型名、透明背景参数或核心抠图算法。`mask`、`alpha`、`PSD` 等字符串更多来自画布、图像库、智能分层或 PSD 导出逻辑，不能证明去背景核心在前端。

## 继续深挖到的接口和后台线索

这次不只看 `remove-bg` 请求体，还检查了主 bundle、按需加载的 admin chunk、运行时网络记录和公开配置。新增结论如下。

### 1. 暴露的函数、RPC 和表

前端 bundle 里能看到 Supabase Function 名称，包括：

```text
remove-bg
layer-image
detect-image-text
generate-image
get-worker-health
admin-job-diagnostics
get-public-config
get-oss-sts
manage-provider-instances
```

能看到的 RPC 包括：

```text
get_image_tool_stats
get_provider_health_tree
get_provider_error_breakdown
get_monitor_stats_by_dim_tree
get_optimization_hints
```

相关表包括：

```text
generation_jobs
canvas_project_snapshots
projects
system_config
model_generation_history
monitor_alert_history
```

这说明 Picell 把去背景和分层放在一套后端任务系统里，而不是前端直接同步调用图片模型。

### 2. 工具任务统计

前端 admin 监控里明确有两个工具类任务：

```js
IMAGE_LAYER: "智能分层（IMAGE_LAYER）"
REMOVE_BG: "去除背景（REMOVE_BG）"
```

`get_image_tool_stats` 会展示：

```text
success_5m / completed_5m
avg_duration_ms_5m / p95_duration_ms_5m
success_15m / completed_15m
avg_duration_ms_15m / p95_duration_ms_15m
success_today / completed_today
avg_duration_ms_today / p95_duration_ms_today / p99_duration_ms_today
self_heal_count_today
```

`self_heal_count_today` 这个字段很关键。它说明后端会统计工具任务内部的救场次数，通常对应 provider retry、fallback 或后处理修复，不像单次 prompt 直出。

### 3. Worker 队列

`get-worker-health` 暴露的前端字段包括：

```text
workers
queue.pending
queue.processing
queue.total
queue.worker_processing
discovery_mode
job_semaphore_total
job_semaphore_running
job_semaphore_waiting
job_semaphore_available
ai_semaphore_total
ai_semaphore_available
active_tasks
```

后台还可配置：

```text
worker_health_urls
batch_concurrency
ai_analysis_concurrency
backend_retry_limit
task_timeout_4k_seconds
task_timeout_other_seconds
```

这说明它的速度体验来自异步任务 + Worker 池 + 队列监控。前端只拿 job_id，真实耗时在后端 Worker 中发生。

### 4. Provider 链路诊断

`admin-job-diagnostics` 前端展示字段包括：

```text
job_id
job_type
job_status
gen_model
gen_resolution
provider_used
job_total_ms
job_duration_ms
job_queue_ms
job_be_retry
error_code
error_message
chain_attempts[]
```

`chain_attempts[]` 每项包括：

```text
attempt_seq
provider
phase
status
http_status
duration_ms
retry_count
error_code
error_msg_excerpt
```

按需加载的 `AdminGenerationLookup` chunk 还会展示：

```text
Payload
Result Data
Provider Meta
worker_id
duration_ms
result_url
```

所以真实 provider、payload、provider_meta 很可能写在后端任务详情里，但普通画布接口没有 select 这些字段，用户侧看不到。

### 5. 后台分层配置暴露了更明确的技术栈

主 bundle 的「分层配置」后台 UI 暴露了这些配置键：

```text
image_layer_inpaint_prompt
image_layer_inpaint_fallback_prompt
image_layer_credit_cost
remove_bg_credit_cost
image_layer_inpaint_model
layer_inpaint_provider_chain
aliyun_imageseg_access_key_id
aliyun_imageseg_access_key_secret
aliyun_imageseg_qps
aliyun_ocr_qps
qwen_api_key
qwen_ocr_prompt
qwen_ocr_url
image_layer_fonts
image_layer_popular_fonts
```

对应 UI 文案写得很直接：

```text
阿里云 API（商品分割 + OCR）
抠图队列 QPS（0=不可用），占位提示：阿里云商品分割默认限制 2
千问 OCR（DashScope）
调用阿里百炼 qwen-vl-ocr 模型识别文字
背景修复 Prompt（必填）：用于 Gemini 修复去除产品+文字后的背景（洋红标记修复）
背景修复回退 Prompt（必填）：洋红修复失败时的回退方案，让 Gemini 直接生成纯背景
```

这是目前最有价值的线索：Picell 的智能分层至少不是纯 GPT Image prompt，而是：

- 商品分割：阿里云 ImageSeg 类能力。
- 文字识别：阿里云 OCR 或 DashScope `qwen-vl-ocr`。
- 背景修复：Gemini 或 provider chain 做 inpaint/纯背景回退。
- 字体：后台维护字体表，用于重建文字层。
- 结果：`background_url/product_url/text_layers` 这类结构返回给画布。

去背景是否 100% 也走同一个阿里云商品分割接口，前端没有直接暴露；但 `remove_bg_credit_cost` 和 `image_layer_*` 在同一个分层配置面板里，且它们同属工具任务监控，强烈暗示去背景复用了“商品分割 + alpha/bbox 裁剪”的轻量链路，而不是完整 GPT Image 重绘。

### 6. Provider 路由配置

后台路由配置暴露了：

```text
turbo_provider_chain
non_turbo_provider_chain
fast_provider_chain
turbo_fallback_chain
non_turbo_fallback_chain
fast_fallback_chain
v2_routing_rules
```

Provider 名称包含：

```text
google_direct
openrouter
apiyi
grsai
laozhang
wuyin
anyfast
wenwen
```

这些更像通用生图/修复 provider。去背景接口没有传 provider，但后端任务诊断会记录 `provider_used` 和 `chain_attempts`。

### 7. 重复执行同一输入时结果稳定

同一张输入图重复点击去背景，得到的 `layers/...png` 文件名不同，但 CDN 返回的：

```text
Content-Length: 887250
ETag: "13758D04C9D46521BCC87E6E79D7AB7E"
Content-MD5: E3WNBMnUZSG8yH5uederfg==
```

完全一致。

这说明同输入下结果是稳定的，或者服务端有内容级缓存/确定性 pipeline。对我们来说，这个线索很实用：可以给去背景结果加输入图片 hash 缓存，同一张图再次去背景直接秒回。

### 8. 没找到的东西

已经搜索主 bundle 和按需 chunk，没有找到能证明去背景核心在前端的：

```text
rembg
rmbg
bria
clipdrop
remove-bg prompt
background=transparent
alpha 参数
model 参数
```

也没有 source map。真实 prompt、provider key、服务端内部代码和 `provider_meta` 都在私有 Edge Function / Worker / DB 后台里，普通前端抓包拿不到。

## 服务端到底可能怎么做

Picell 的 Edge Function 是私有服务端代码，前端抓包拿不到真实 prompt 和内部模型调用。因此不能说“100% 拿到了它的 prompt”。

但从输入、输出、速度和新增后台线索可以确定它至少做了这些步骤：

1. 读取 OSS 上的原图。
2. 调用服务端去背景能力。更可能是专用商品分割或产品图抠图服务；智能分层已明确暴露阿里云商品分割、OCR、Qwen OCR 和背景修复配置。
3. 得到主体透明 PNG。
4. 计算 alpha bbox。
5. 裁剪主体图，上传到 `layers/...png`。
6. 把 `product_url/original_width/original_height/product_offset_x/product_offset_y/product_width/product_height` 写入 `generation_jobs.result_data`。

更合理的推断是：它不是只靠一句 GPT Image prompt。对于复杂电商图，稳定结果通常需要“专用商品分割/主体 mask + alpha 后处理 + bbox 裁剪 + 缓存 + 必要时 fallback”。同款 GPT Image 模型并不等于同款效果，因为分割模型、后处理、透明输出能力、异步任务、重试策略、裁剪策略和缓存都会影响最终质量。

## 为什么我们之前效果差

之前我们的问题不是画布背景，也不是前端显示错误，而是后端输出的 PNG alpha 坏了：

- 模型有时返回“棋盘格假透明背景”，不是实际 alpha。
- 后处理把白色包装、浅色面板、文字区域误判成背景，设成 alpha=0。
- 深色画布从透明洞透出来，就变成用户看到的黑块。
- 多轮 fallback/retry 会让速度变慢，还可能把一个可用结果替换成更差的结果。

所以通用修复方向应该是：不写针对某张图的规则，只保证 pipeline 不误伤主体内部。

## 本项目应该对齐的通用方案

推荐实现分三层，按优先级执行。

### A. 最优路线：真实透明输出

如果当前模型渠道支持透明背景参数，直接让模型返回透明 PNG：

```text
只保留真实商品主体，删除背景、文案区、色块、场景和多余留白。
商品本体、包装、包装上的印刷文字和图案都属于主体，必须保留。
输出透明背景 PNG。不要重绘，不要改字。
```

然后后端只做：

- alpha bbox。
- 裁剪透明边。
- 小洞修复：只填补被主体包围、没有连到外部背景的透明洞。
- 输出 bbox 元数据。

### B. 当前可行路线：纯色 key 背景 + 安全转 alpha

如果当前 `gpt-image-2` 渠道不支持 `background=transparent`，不要让模型画棋盘格。棋盘格太容易和白色包装、灰白文字区域混在一起。

更稳的通用做法是让模型输出主体放在纯色 key 背景上，例如纯绿色 `#00FF00`：

```text
请做严格、通用的商品去背景抠图。只保留真实商品主体，删除所有背景、色块、白底、文案区、边框、场景和多余留白。
商品本体、包装、包装上的印刷文字和图案都属于主体，必须保留。
把主体放在均匀纯绿色 #00FF00 背景上，不要棋盘格、不要白底、不要灰底、不要阴影。
不要重绘，不要美化，不要改字，不要添加新元素。输出 PNG。
```

后处理只删除“从边缘连通进来的纯绿色区域”，不要全图按颜色删除。这样商品内部的绿色标签、绿色 logo 不会被误删。

### C. 兜底路线：本地分割模型

如果 AI 输出失败，兜底可以用本地分割模型，但不能静默返回很差的结果。应该：

- 明确标记为 fallback。
- 输出质量不达标时返回错误，而不是把整张广告图当去背景结果。
- 只作为兜底，不作为主路径。

## 我们要改成的产品体验

对标 Picell，前端体验应该是：

- 点击“去除背景”后，源图旁边出现 loading 占位。
- 后端完成后，新节点只显示透明主体图。
- 新节点没有 prompt 输入框。
- 新节点尺寸按主体 PNG 比例显示。
- 保存 bbox 元数据，后续 PSD/分层/连接线可以复用。

接口返回建议保持：

```json
{
  "imageDataUrl": "data:image/png;base64,...",
  "productDataUrl": "data:image/png;base64,...",
  "originalWidth": 1200,
  "originalHeight": 1200,
  "productOffsetX": 566,
  "productOffsetY": 43,
  "productWidth": 634,
  "productHeight": 966
}
```

## 关键代码位置

- 后端服务：`service/remove_background.go`
- HTTP 接口：`handler/remove_background.go`
- 前端 API：`web/src/services/api/image.ts`
- 画布节点创建：`web/src/app/(user)/canvas/[id]/canvas-client-page.tsx`
- 回归测试：`service/remove_background_test.go`

## 本项目当前落地实现

已把去背景主路径改为阿里云视觉智能开放平台 ImageSeg 的 `SegmentCommodity` 商品分割：

1. `service.RemoveBackground` 先判断 `ALIYUN_ACCESS_KEY_ID` 和 `ALIYUN_ACCESS_KEY_SECRET` 是否已配置。
2. 已配置时优先调用 `SegmentCommodityAdvance`，直接上传原图流。
3. 请求参数使用 `ReturnForm=crop`，让阿里云返回裁切后的透明主体图。
4. 后端立即下载阿里云返回的临时图片 URL，不把临时 URL 暴露给前端。
5. 继续通过 `normalizeTransparentCutout` 统一计算 alpha bbox、裁掉透明边、输出 PNG 和尺寸元数据。
6. 同一张原图用 SHA-256 做内存缓存，重复点击会直接返回缓存结果，减少等待和扣费。
7. 如果阿里云调用失败，会记录日志并回退到原来的 GPT/local 去背景逻辑。

需要的环境变量：

```env
ALIYUN_ACCESS_KEY_ID=
ALIYUN_ACCESS_KEY_SECRET=
ALIYUN_IMAGESEG_REGION=cn-shanghai
ALIYUN_IMAGESEG_ENDPOINT=imageseg.cn-shanghai.aliyuncs.com
ALIYUN_IMAGESEG_ENABLED=true
ALIYUN_IMAGESEG_TIMEOUT_SECONDS=20
```

真实 AK 只放本机 `.env` 或部署环境变量，不提交到仓库。由于 AK 已在聊天里明文出现，测试完成后建议在阿里云控制台轮换一次。

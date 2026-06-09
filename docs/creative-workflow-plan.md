# 创作工作流功能开发方案

## 目标

创作工作流用于沉淀可重复使用的图片生成流程。用户只需要填写少量变量，例如产品名称、卖点、活动信息、目标人群、尺寸和参考图，就能复用固定提示词、模型参数和生成步骤，快速生成同类型图片。

典型场景：

- 电商海报：固定风格、构图、营销文案结构，仅替换产品、卖点、活动价格。
- 小红书封面：固定封面模板、标题结构、风格关键词，仅替换主题和关键词。
- 角色设定图：固定角色描述框架，仅替换年龄、服饰、场景、镜头。
- UI 视觉稿：固定品牌风格和组件要求，仅替换行业、页面类型、功能列表。

## 产品形态

### 1. 工作流库

新增「创作工作流」入口，展示用户创建的工作流模板。

每个工作流卡片包含：

- 名称
- 分类
- 封面预览
- 适用场景
- 最近使用时间
- 快速运行按钮
- 编辑、复制、删除按钮

### 2. 工作流编辑器

编辑器分为三块：

- 基础信息：名称、分类、描述、封面。
- 输入变量：文本、长文本、数字、枚举、图片、开关。
- 生成配置：系统提示词、用户提示词模板、参考图规则、模型、尺寸、质量、格式、数量、审核、超时、是否流式。

提示词模板支持变量插值：

```text
为 {{product_name}} 生成一张电商主图。
产品卖点：{{selling_points}}
活动信息：{{campaign}}
风格要求：高端、干净、强视觉冲击。
```

### 3. 工作流运行页

运行页只展示用户需要填写的变量，不暴露完整复杂参数。

页面结构：

- 左侧或上方：变量表单。
- 中部：生成预览和历史结果。
- 右侧：高级参数，可折叠。
- 底部：运行按钮、批量运行、保存为新工作流。

运行后生成的图片进入普通历史结果，也记录来源工作流。

## 数据模型

建议新增后端表，方便后续多端同步和团队共享。

### workflow

```ts
type CreativeWorkflow = {
  id: string;
  userId: string;
  name: string;
  category: string;
  description: string;
  coverUrl: string;
  variables: WorkflowVariable[];
  config: WorkflowGenerationConfig;
  createdAt: string;
  updatedAt: string;
};
```

### variable

```ts
type WorkflowVariable = {
  key: string;
  label: string;
  type: "text" | "textarea" | "number" | "select" | "image" | "boolean";
  required: boolean;
  defaultValue?: string | number | boolean;
  options?: string[];
  placeholder?: string;
  helpText?: string;
};
```

### generation config

```ts
type WorkflowGenerationConfig = {
  systemPrompt: string;
  promptTemplate: string;
  negativePrompt?: string;
  model: string;
  apiMode: "images" | "responses";
  size: string;
  quality: string;
  outputFormat: "png" | "jpeg" | "webp";
  outputCompression: string;
  moderation: string;
  count: string;
  timeout: string;
  streamImages: boolean;
  responseFormatB64Json: boolean;
  codexCli: boolean;
};
```

### generation log 扩展

生成记录增加：

```ts
workflowId?: string;
workflowName?: string;
workflowInputs?: Record<string, unknown>;
```

## 接口设计

```text
GET    /api/workflows
POST   /api/workflows
GET    /api/workflows/:id
POST   /api/workflows/:id
DELETE /api/workflows/:id
POST   /api/workflows/:id/run
```

`run` 接口也可以先不单独做，前端先把变量渲染成最终 prompt，再复用现有 `/api/v1/images` 或 `/api/v1/responses`。长期建议保留 `run` 接口，方便做审计、扣费、批量任务和权限控制。

## 分阶段实现

### 第一期：个人模板

- 新增工作流库页面。
- 支持创建、编辑、复制、删除工作流。
- 支持变量表单和 prompt 模板渲染。
- 运行时复用当前生图服务。
- 生成记录写入 `workflowId` 和输入快照。

### 第二期：模板市场

- 增加官方模板和用户模板区分。
- 支持导入、导出 JSON。
- 支持按行业、用途、模型筛选。
- 支持从一次成功生成结果反向保存为工作流。

### 第三期：多步骤工作流

- 支持步骤编排：提示词改写、首图生成、局部重绘、批量尺寸适配。
- 支持条件分支和批量变量。
- 支持将结果自动加入素材库或画布。

## 与成熟产品的设计参考

可参考的成熟产品思路：

- Canva 模板：用户只改变量，复杂设计规则隐藏在模板里。
- ComfyUI 工作流：节点化能力强，但普通用户理解成本高，本项目第一期不建议直接节点化。
- Midjourney 风格参数：模板内沉淀风格和参数，运行时只暴露少量可控项。
- Notion 模板库：模板可复制、分类、搜索、复用。

本项目更适合采用「表单变量 + 固定提示词模板 + 可折叠高级参数」的方式，先让普通用户能稳定复用，再逐步扩展到多步骤编排。

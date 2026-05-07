# MuseForge Backend API

默认地址：

```text
http://127.0.0.1:8787
```

这份文档只记录当前后端应维护的主要接口。未来 Recipe、ComfyUI、云端引擎和视频接口在实现后再补充。

## 1. 健康与引擎

### GET /health

返回后端、A1111 和当前 Provider 的基础状态。

### GET /api/engines/status

返回本地绘图引擎安装、运行和健康检查状态。

### GET /api/engines/models

返回 A1111 可见的 checkpoint、LoRA、VAE、ControlNet 和 sampler。

### GET /api/models/local

扫描本地模型资源目录，供资源面板和规划器使用。

## 2. Prompt Tag 工具

### GET /api/prompt-tools/tags

搜索 prompt-all-in-one 标签库。

查询参数：

- `q`：搜索关键词。
- `locale`：默认 `zh_CN`。
- `groupId`：可选标签组。
- `limit`：默认 `180`。

用途：

- 生图 Agent 生成 tag prompt。
- 工作台后续提供 tag 搜索和 prompt preset 组合。

## 3. 生图规划

### POST /api/generate/plan

把自然语言需求转换为可确认的 `GenerationPlan`。当前默认是轻量 tag planning，不再默认执行复杂 Agent 工具循环。

请求：

```json
{
  "userRequest": "画一个银发少女，黑色礼服，雨夜咖啡馆，二次元立绘"
}
```

响应：

```json
{
  "plan": {
    "task_type": "txt2img",
    "positive_prompt": "1girl, silver hair, black dress...",
    "negative_prompt": "bad hands, extra fingers, low quality, blurry...",
    "checkpoint": "anything-v5.safetensors",
    "lora": [],
    "width": 512,
    "height": 768,
    "sampler": "Euler a",
    "steps": 8,
    "cfg_scale": 5,
    "seed": -1,
    "batch_size": 1,
    "hires_fix": false,
    "adetailer": false,
    "rationale": "..."
  },
  "tagSuggestions": [],
  "resourceSummary": {}
}
```

约束：

- `width/height` 表示实际 txt2img 尺寸。
- `target_width/target_height` 当前不作为默认高清放大目标。
- 默认不启用 Hires Fix、Extras upscale、ADetailer 或视觉评分。
- 无触发词 LoRA 不会被自动翻译或编造成 prompt tag。

### POST /api/generate/revise

基于已有 plan、对话和新增要求重新生成方案。

请求：

```json
{
  "plan": {},
  "conversation": [],
  "userRequest": "改成头像构图"
}
```

## 4. 生图任务

### POST /api/tasks/generate

创建 A1111 txt2img 任务。

请求：

```json
{
  "plan": {
    "task_type": "txt2img",
    "positive_prompt": "1girl, masterpiece",
    "negative_prompt": "bad hands, blurry",
    "width": 512,
    "height": 768,
    "sampler": "Euler a",
    "steps": 8,
    "cfg_scale": 5,
    "seed": -1,
    "batch_size": 1
  }
}
```

响应：

```json
{
  "taskId": "uuid",
  "task": {
    "id": "uuid",
    "backend": "a1111",
    "status": "queued"
  }
}
```

### POST /api/generate/run

兼容入口，内部等同于 `POST /api/tasks/generate`。

### GET /api/tasks

返回任务列表。支持 `limit`、`offset`。

### GET /api/tasks/:id

返回单个任务状态、进度、错误和结果。

### POST /api/tasks/:id/cancel

取消队列中或运行中的任务。

### POST /api/tasks/:id/retry

用相同 plan 重试任务。

## 5. 生成结果

### GET /api/generations

返回已保存图片记录。支持 `limit`、`offset`。

### GET /api/generations/:id

返回单张图片记录。

### PUT /api/generations/:id

更新生成记录，例如收藏、备注或标签。

### DELETE /api/generations/:id

删除生成记录和可选图片文件。

### POST /api/generations/:id/open

在系统文件管理器中打开图片所在位置。

### DELETE /api/generations

批量删除生成记录。

## 6. 资源管理

### GET /api/resources

返回本地资源索引。

### POST /api/resources/scan

重新扫描本地模型资源。

### POST /api/resources/install

把用户提供的资源文件安装到对应模型目录。

### PUT /api/resources/profile

更新资源档案，例如 title、baseType、triggerWords、defaultWeight、notes。

### PUT /api/resources/purpose

更新资源用途标记。

### POST /api/resources/validate-plan

校验 plan 中的 checkpoint、LoRA、VAE、ControlNet 兼容性。

## 7. Provider 与运行时设置

### GET /api/providers

返回已保存 Provider 配置和当前启用配置。API Key 不回显明文。

### POST /api/providers

新增 Provider。

### PUT /api/providers/:id

更新 Provider。省略 `apiKey` 表示保持原密钥。

### DELETE /api/providers/:id

删除 Provider。

### POST /api/providers/:id/activate

启用某个 Provider。

### POST /api/providers/:id/test

测试 Provider 连接。

### GET /api/providers/status

返回当前 Provider 状态。

### GET /api/settings/runtime

读取运行时设置，例如低性能模式。

### PUT /api/settings/runtime

更新运行时设置。

## 8. 本地 LLM

### GET /api/local-llm/status

返回 Ollama 安装、运行和模型状态。

### POST /api/local-llm/install

安装或启动本地 LLM 运行时。

### GET /api/local-llm/library

搜索 Ollama 模型库。

### GET /api/local-llm/model-info

读取某个 Ollama 模型信息。

### POST /api/local-llm/pull

拉取指定 Ollama 模型。

### POST /api/local-llm/pull-gemma

兼容入口，拉取默认 Gemma 模型。

### GET /api/local-llm/pulls

返回模型拉取任务列表。

### GET /api/local-llm/pulls/:id

返回单个拉取任务状态。

### DELETE /api/local-llm/models/:model

删除本地 Ollama 模型。

## 9. ControlNet

当前为资源层能力，完整用户工作流仍在后续阶段。

- `POST /api/controlnet/reference-images`
- `GET /api/controlnet/presets`
- `POST /api/controlnet/presets/:id/install`
- `POST /api/controlnet/import`
- `GET /api/controlnet/resources`
- `POST /api/controlnet/resources/scan`

## 10. LoRA 项目

当前为 LoRA 制作工作流雏形，后续会收敛为 Character IP 创建流程。

- `GET /api/kohya/status`
- `GET /api/kohya/install`
- `POST /api/kohya/install`
- `POST /api/lora/plan`
- `GET /api/lora/projects`
- `POST /api/lora/projects`
- `GET /api/lora/projects/:id`
- `POST /api/lora/projects/:id/assets`
- `POST /api/lora/projects/:id/inspect`
- `PUT /api/lora/projects/:id/captions`
- `POST /api/lora/projects/:id/plan`
- `POST /api/lora/projects/:id/train`
- `POST /api/lora/projects/:id/install`

## 11. 下一阶段 API

P1 应新增：

- `GET /api/recipes`
- `POST /api/recipes`
- `GET /api/recipes/:id`
- `PUT /api/recipes/:id`
- `DELETE /api/recipes/:id`
- `POST /api/recipes/:id/generate`
- `POST /api/generation-groups`
- `GET /api/generation-groups/:id`

这些接口用于 Recipe 保存、批量抽卡、seed 策略和结果分组。

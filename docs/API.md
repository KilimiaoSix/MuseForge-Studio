# Backend API 草案

默认地址：

```text
http://127.0.0.1:8787
```

## GET /health

检查后端、A1111 状态和默认 Provider。

响应示例：

```json
{
  "ok": true,
  "inferenceBackend": "a1111",
  "webuiBaseUrl": "http://127.0.0.1:7860",
  "provider": "openai-compatible",
  "engines": {
    "a1111": {}
  }
}
```

## GET /api/engines/status

返回 A1111 的安装状态、运行状态、模型目录和健康检查结果。

## GET /api/engines/models

返回 A1111 可见的 checkpoint、LoRA、VAE、ControlNet 和 sampler 信息。

## GET /api/models/local

扫描本地 A1111 模型资源。

响应字段：

- `checkpoints`
- `loras`
- `vaes`
- `controlnet`
- `samplers`

## POST /api/generate/plan

把自然语言需求转换成生图方案。

请求：

```json
{
  "userRequest": "画一个银发少女，穿黑色礼服，坐在雨夜咖啡馆窗边，适合手机壁纸"
}
```

响应：

```json
{
  "plan": {
    "task_type": "txt2img",
    "positive_prompt": "1girl, silver hair...",
    "negative_prompt": "bad hands, extra fingers...",
    "checkpoint": "animagineXL40_v4Opt.safetensors",
    "width": 512,
    "height": 768,
    "target_width": 768,
    "target_height": 1152,
    "sampler": "Euler a",
    "steps": 12,
    "cfg_scale": 5,
    "seed": -1,
    "batch_size": 1,
    "hires_fix": {
      "enabled": true,
      "mode": "resize",
      "target_width": 768,
      "target_height": 1152
    },
    "adetailer": false,
    "rationale": "竖版动漫角色图..."
  }
}
```

## POST /api/generate/revise

基于已有 `GenerationPlan` 和对话补充修改生图方案。

## POST /api/generate/run

创建一个 A1111 生图任务。该接口保持兼容，内部等同于 `POST /api/tasks/generate`。

请求：

```json
{
  "plan": {
    "task_type": "txt2img",
    "positive_prompt": "1girl, high quality",
    "negative_prompt": "bad hands, low quality",
    "width": 512,
    "height": 768,
    "sampler": "Euler a",
    "steps": 12,
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
    "backend": "a1111",
    "status": "queued"
  }
}
```

## POST /api/tasks/generate

创建 A1111 生图任务。

## GET /api/tasks

返回任务队列。

## GET /api/tasks/:id

返回单个任务状态。

## POST /api/tasks/:id/cancel

取消队列中或运行中的 A1111 任务。

## POST /api/tasks/:id/retry

用相同计划重试任务。

## GET /api/generations

返回已保存的生成结果。

## DELETE /api/generations/:id

删除生成记录和对应图片文件。

## POST /api/lora/plan

生成 LoRA 训练配置草案。

请求：

```json
{
  "projectName": "silver_aria"
}
```

## GET /api/providers

返回 Web 中保存的 Provider 配置档、当前启用配置和默认本地 Gemma 配置。

## POST /api/providers

新增 Provider 配置档。`apiKey` 会加密保存，不会在后续响应中明文返回。

```json
{
  "name": "Local Gemma 4 E4B",
  "type": "local",
  "baseUrl": "http://127.0.0.1:11434/v1",
  "model": "gemma4:e4b",
  "apiKey": "",
  "isActive": true
}
```

## PUT /api/providers/:id

更新 Provider 配置档。省略 `apiKey` 表示保持已保存密钥；传空字符串表示清空密钥。

## POST /api/providers/:id/activate

启用指定 Provider 配置档。

## POST /api/providers/:id/test

测试指定 Provider 配置档，并记录测试状态。

## DELETE /api/providers/:id

删除 Provider 配置档。删除当前启用项后会自动启用最近更新的配置；没有配置时回退到 `.env`。

## GET /api/providers/status

返回当前启用 Provider。优先读取 SQLite active profile；没有 active profile 时读取 `.env`。

## POST /api/providers/test

测试当前启用 Provider。

## GET /api/local-llm/status

返回本地 Ollama 与 `gemma4:e4b` 状态。

## POST /api/local-llm/pull-gemma

调用 `ollama pull gemma4:e4b` 拉取本地模型。请求可能耗时较长。


## Runtime Performance Settings

### GET /api/settings/runtime

Returns runtime performance settings.

```json
{
  "settings": {
    "lowPerformanceMode": false
  }
}
```

### PUT /api/settings/runtime

Updates runtime performance settings.

When `lowPerformanceMode` is enabled, generation tasks use a VRAM-saving flow:

- before A1111 image generation, stop the active local Ollama model with `ollama stop <model>`
- after the A1111 task completes, unload the checkpoint with `/sdapi/v1/unload-checkpoint`
- the next LLM planning request or image generation request will load its model on demand

```json
{
  "lowPerformanceMode": true
}
```

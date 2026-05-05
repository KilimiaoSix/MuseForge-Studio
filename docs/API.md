# Backend API 草案

默认地址：

```text
http://127.0.0.1:8787
```

## GET /health

检查后端、默认推理后端、ComfyUI/A1111 状态和默认 Provider。

响应示例：

```json
{
  "ok": true,
  "inferenceBackend": "comfyui",
  "webuiBaseUrl": "http://127.0.0.1:7860",
  "comfyuiBaseUrl": "http://127.0.0.1:8188",
  "provider": "openai-compatible",
  "engines": {}
}
```

## GET /api/engines/status

返回 ComfyUI 和 A1111 的安装状态、运行状态、模型目录和健康检查结果。

## GET /api/engines/models

返回 ComfyUI 和 A1111 可见的 checkpoint 信息。

## GET /api/models/local

扫描本地 WebUI 模型资源。

响应字段：

- `checkpoints`
- `loras`
- `vaes`
- `controlnet`

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
    "width": 832,
    "height": 1472,
    "sampler": "DPM++ 2M Karras",
    "steps": 28,
    "cfg_scale": 6.5,
    "seed": -1,
    "batch_size": 4,
    "hires_fix": true,
    "adetailer": true,
    "rationale": "竖版动漫角色图..."
  }
}
```

## POST /api/generate/run

执行生图。默认根据 `INFERENCE_BACKEND` 分流到 ComfyUI 或 A1111。

也可以在请求体中临时覆盖：

```json
{
  "backend": "comfyui",
  "plan": {}
}
```

请求：

```json
{
  "plan": {
    "task_type": "txt2img",
    "positive_prompt": "1girl, high quality",
    "negative_prompt": "bad hands, low quality",
    "width": 832,
    "height": 1216,
    "sampler": "DPM++ 2M Karras",
    "steps": 28,
    "cfg_scale": 6.5,
    "seed": -1,
    "batch_size": 1
  }
}
```

响应：

- `backend=a1111`：返回 A1111 `/sdapi/v1/txt2img` 结果，并附带 backend/baseUrl。
- `backend=comfyui`：返回 `prompt_id`、workflow、history 和图片 URL。

## POST /api/lora/plan

生成 LoRA 训练配置草案。

请求：

```json
{
  "projectName": "silver_aria"
}
```

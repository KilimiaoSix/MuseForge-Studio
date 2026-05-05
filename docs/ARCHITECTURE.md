# SD Agent Studio 工程架构

## 目标

这个项目包用于后续在其他平台继续开发，不包含模型权重和真实密钥。代码结构按轻量 monorepo 组织：

```text
sd-agent-studio-product/
  apps/
    backend/        # Agent API 服务，负责工作流编排和调用 WebUI
    ui-prototype/   # 高保真静态 UI 原型
  packages/
    model-providers/# OpenAI / OpenAI-compatible / 本地模型 / Claude 类适配
    shared/         # 共享类型、schema、示例数据
  docs/
    PRD-V1.md
    ARCHITECTURE.md
  screens/
    *.png
  tools/
    generate_assets.py
    export_screens.mjs
```

## 后端职责

`apps/backend` 是独立 API 服务，不直接持有模型权重。

主要职责：

- 接收 UI 的自然语言请求。
- 调用 `packages/model-providers` 生成结构化方案。
- 校验并补全方案。
- 调用本地 Aki / SD WebUI API。
- 调用本地 ComfyUI API。
- 在 ComfyUI 和 A1111 WebUI 之间切换推理后端。
- 扫描本地模型资源目录。
- 管理任务队列与任务状态。
- 为 LoRA 炼制生成数据处理和训练配置。

## 模型调用职责

`packages/model-providers` 只负责大语言模型调用，不负责 SD 推理。

Provider 类型：

- OpenAI
- OpenAI-compatible
- Local OpenAI-compatible gateway，例如 LM Studio、Ollama bridge、vLLM
- Anthropic / Claude-like Messages API

Provider 输出统一为共享 schema，例如 `GenerationPlan`、`EditPlan`、`LoraTrainingPlan`。

## SD WebUI 调用

后端可以通过 HTTP 调用本地 A1111 / Aki WebUI：

- `POST /sdapi/v1/txt2img`
- `POST /sdapi/v1/img2img`
- `GET /sdapi/v1/sd-models`
- `GET /sdapi/v1/loras`，如果目标 WebUI/扩展支持
- `GET /sdapi/v1/progress`

第一版只提供客户端封装和 mock fallback，真实出图依赖用户本地 WebUI 已启动。

## ComfyUI 调用

ComfyUI 作为默认推理后端，通过 `INFERENCE_BACKEND=comfyui` 启用。

第一版支持基础 txt2img 工作流：

- CheckpointLoaderSimple
- CLIPTextEncode
- EmptyLatentImage
- KSampler
- VAEDecode
- SaveImage

后端调用流程：

1. 把 `GenerationPlan` 转换成 ComfyUI workflow JSON。
2. 调用 `POST /prompt`。
3. 轮询 `GET /history/{prompt_id}`。
4. 从 history 中提取 `/view` 图片 URL。

ControlNet、LoRA、img2img、inpaint 在后续迭代通过扩展 workflow builder 实现。

## 引擎部署

大后端源码不提交到项目仓库。使用：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap-engines.ps1
```

把 ComfyUI 和 A1111 克隆到：

```text
vendor/engines/
```

## LoRA 训练

LoRA 训练不把训练器放进仓库。后端只保留：

- 数据集质检接口
- 标签清洗接口
- 训练配置生成接口
- 外部训练器命令适配预留

默认训练器：

- `kohya_ss`
- `sd-scripts`

训练器路径通过环境变量配置。

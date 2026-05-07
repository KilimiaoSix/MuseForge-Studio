# A1111 推理后端部署说明

MuseForge Studio 当前本地绘图引擎默认接入 AUTOMATIC1111 WebUI / Aki WebUI。项目不会提交后端源码和模型权重，默认把 WebUI 放在：

```text
vendor/engines/stable-diffusion-webui
```

## 快速开始

这份文档只覆盖当前本地 A1111 / Aki WebUI 部署。后续桌面客户端可以复用这些检查和启动脚本，但不再单独维护一份安装向导文档。

产品层后续会支持 ComfyUI、云端图像 API 和视频模型；这些能力实现后再补充独立说明。

在项目根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap-engines.ps1
```

Linux / macOS：

```bash
bash scripts/bootstrap-engines.sh
```

启动开发栈：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-dev.ps1
```

Linux / macOS：

```bash
bash scripts/start-dev.sh
```

启动内容：

- A1111 WebUI：`http://127.0.0.1:7860`
- SD Agent Backend：`http://127.0.0.1:8787`
- UI Prototype：`http://127.0.0.1:5177`

## 启动单个后端

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-a1111.ps1
```

Linux / macOS：

```bash
bash scripts/start-a1111.sh
```

## 环境变量

复制 `.env.example` 为 `.env`，按需设置：

```text
A1111_BASE_URL=http://127.0.0.1:7860
SD_WEBUI_BASE_URL=http://127.0.0.1:7860
PYTORCH_ENABLE_MPS_FALLBACK=1
```

如果你已经有可用的 Aki WebUI / A1111 服务，可以不使用脚本安装，只把 `A1111_BASE_URL` 指向已有服务。

macOS Apple Silicon 使用 MPS 后端时，建议保留 `PYTORCH_ENABLE_MPS_FALLBACK=1`。它可以让 PyTorch 遇到暂不支持的 MPS 算子时回退到 CPU，避免部分模型或插件在 txt2img 时出现 `Placeholder storage has not been allocated on MPS device!`。

## 模型放置位置

模型不会自动下载，需要用户自己放入对应目录。

```text
vendor/engines/stable-diffusion-webui/models/Stable-diffusion
vendor/engines/stable-diffusion-webui/models/Lora
vendor/engines/stable-diffusion-webui/models/VAE
vendor/engines/stable-diffusion-webui/models/ControlNet
```

## 健康检查

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-engines.ps1
```

Linux / macOS：

```bash
bash scripts/check-engines.sh
```

API：

```text
GET http://127.0.0.1:8787/api/engines/status
GET http://127.0.0.1:8787/api/engines/models
```

## 本地大语言模型

默认本地规划模型使用 Ollama 运行 `gemma4:e4b`：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-gemma4-e4b.ps1
```

Web 设置页的“本地大模型”面板可以一键安装并启动 Ollama。该入口支持 macOS Homebrew 与 Windows winget；如果缺少对应包管理器，页面会提示手动安装链接。Web 入口不会自动拉取 `gemma4:e4b`，安装成功后仍需在页面中选择并拉取模型。

完成后在 Web 设置页点击“创建并启用 Gemma”，或手动新增：

```text
type=local
baseUrl=http://127.0.0.1:11434/v1
model=gemma4:e4b
```

状态 API：

```text
GET http://127.0.0.1:8787/api/local-llm/status
POST http://127.0.0.1:8787/api/local-llm/pull-gemma
```

## 常见问题

### A1111 第一次启动很慢

A1111 的 `webui.bat` / `webui.sh` 会在第一次启动时安装 Python 依赖，耗时较长，属于正常现象。

### 没检测到 checkpoint

把 `.safetensors` 或 `.ckpt` 放到：

```text
vendor/engines/stable-diffusion-webui/models/Stable-diffusion
```

或者在 `GenerationPlan.checkpoint` 中指定 A1111 已经能看到的模型名。


## Low Performance / VRAM-Saving Mode

The Web settings page includes a low-performance mode for machines where Ollama and A1111 compete for VRAM.

When enabled:

- local LLM planning still uses the active local provider, such as `gemma4:e4b`
- before an A1111 generation task starts, the backend runs `ollama stop <active local model>`
- A1111 loads the requested checkpoint for the task
- after the task completes, the backend calls `POST /sdapi/v1/unload-checkpoint`

This mode can significantly slow down planning and image generation because models are loaded on demand, but it reduces peak VRAM pressure.

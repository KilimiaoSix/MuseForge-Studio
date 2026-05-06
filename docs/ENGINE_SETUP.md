# A1111 推理后端部署说明

SD Agent Studio 暂时只接入 AUTOMATIC1111 WebUI / Aki WebUI。项目不会提交后端源码和模型权重，默认把 WebUI 放在：

```text
vendor/engines/stable-diffusion-webui
```

## 快速开始

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
```

如果你已经有可用的 Aki WebUI / A1111 服务，可以不使用脚本安装，只把 `A1111_BASE_URL` 指向已有服务。

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

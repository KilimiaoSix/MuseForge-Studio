# 推理后端一键部署说明

SD Agent Studio 支持把 ComfyUI 和 AUTOMATIC1111 WebUI 作为本地推理后端。项目不会提交后端源码和模型权重，而是通过脚本把它们克隆到 `vendor/engines/`。

## 快速开始

在项目根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap-engines.ps1
```

Linux / macOS：

```bash
bash scripts/bootstrap-engines.sh
```

启动默认开发栈：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-dev.ps1
```

Linux / macOS：

```bash
bash scripts/start-dev.sh
```

默认启动：

- ComfyUI：`http://127.0.0.1:8188`
- SD Agent Backend：`http://127.0.0.1:8787`
- UI Prototype：`http://127.0.0.1:5177`

## 只安装某个后端

只安装 ComfyUI：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap-engines.ps1 -ComfyOnly
```

Linux / macOS：

```bash
bash scripts/bootstrap-engines.sh --comfy-only
```

只安装 A1111：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap-engines.ps1 -A1111Only
```

Linux / macOS：

```bash
bash scripts/bootstrap-engines.sh --a1111-only
```

## 启动单个后端

ComfyUI：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-comfyui.ps1
```

Linux / macOS：

```bash
bash scripts/start-comfyui.sh
```

A1111：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-a1111.ps1
```

Linux / macOS：

```bash
bash scripts/start-a1111.sh
```

## 切换默认推理后端

复制 `.env.example` 为 `.env`，设置：

```text
INFERENCE_BACKEND=comfyui
```

或：

```text
INFERENCE_BACKEND=a1111
```

也可以在请求 `/api/generate/run` 时传入：

```json
{
  "backend": "a1111",
  "plan": {}
}
```

## 模型放置位置

模型不会自动下载，需要用户自己放入对应目录。

ComfyUI：

```text
vendor/engines/ComfyUI/models/checkpoints
vendor/engines/ComfyUI/models/loras
vendor/engines/ComfyUI/models/vae
vendor/engines/ComfyUI/models/controlnet
```

A1111：

```text
vendor/engines/stable-diffusion-webui/models/Stable-diffusion
vendor/engines/stable-diffusion-webui/models/Lora
vendor/engines/stable-diffusion-webui/models/VAE
vendor/engines/stable-diffusion-webui/models/ControlNet
```

如果已经有 Aki WebUI，可以不安装官方 A1111，直接设置：

```text
A1111_BASE_URL=http://127.0.0.1:7860
SD_WEBUI_BASE_URL=http://127.0.0.1:7860
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

## 常见问题

### ComfyUI 报缺少 checkpoint

把 `.safetensors` 或 `.ckpt` 放到：

```text
vendor/engines/ComfyUI/models/checkpoints
```

或在 `GenerationPlan.checkpoint` 中指定已存在的文件名。

### A1111 第一次启动很慢

A1111 的 `webui.bat` 会在第一次启动时安装 Python 依赖，耗时较长，属于正常现象。

### 不想下载大后端源码

可以只把 `COMFYUI_BASE_URL` 或 `A1111_BASE_URL` 指向已有服务。脚本不是必需的。

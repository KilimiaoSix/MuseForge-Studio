# SD Agent Studio

这是一个方便后续 vibe coding 的产品工程包：包含需求文档、高保真 UI 原型、后端 API 脚手架、模型 Provider 适配层和共享协议。仓库不包含模型权重和真实 API Key。

## 目录

```text
apps/
  backend/        后端 API 服务，负责任务编排、A1111 WebUI 调用、模型扫描
  ui-prototype/   React/Vite UI 原型
packages/
  model-providers/ OpenAI、OpenAI-compatible、本地模型、Claude 类 Provider
  shared/          共享类型、默认值、示例 schema
docs/
  PRD-V1.md
  ARCHITECTURE.md
  VIBE_CODING_HANDOFF.md
screens/          7 张 UI 产品图
tools/            资产生成和截图导出脚本
```

## 快速查看

PRD：

`docs/PRD-V1.md`

UI 原型：

`apps/ui-prototype/prototype/index.html`

兼容入口：

`prototype/index.html`

产品截图：

`screens/`

## 开发入口

安装依赖：

```bash
npm install
```

一键拉取 A1111 后端：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap-engines.ps1
```

Linux / macOS：

```bash
bash scripts/bootstrap-engines.sh
```

一键启动 A1111、Agent backend 和 UI：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-dev.ps1
```

Linux / macOS：

```bash
bash scripts/start-dev.sh
```

启动后端：

```bash
npm run dev:backend
```

启动 UI 原型静态服务：

```bash
npm run dev:ui
```

部署并验证本地 Gemma 4 E4B：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-gemma4-e4b.ps1
```

脚本会检查/安装 Ollama，拉取 `gemma4:e4b`，并验证 Ollama 的 OpenAI-compatible `/v1/chat/completions` 接口。

导出产品图：

```bash
npm run export:screens
```

## 环境变量

复制 `.env.example` 为 `.env`，按需填写：

- `SD_WEBUI_BASE_URL`
- `A1111_BASE_URL`
- `ENGINE_INSTALL_DIR`
- `AGENT_PROVIDER`
- `AGENT_BASE_URL`
- `AGENT_MODEL`
- `AGENT_API_KEY`
- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `KOHYA_SS_PATH`
- `SD_SCRIPTS_PATH`

## 不要提交

- 模型权重：`.safetensors`、`.ckpt`、`.pt`、`.pth`、`.gguf`
- `.env`
- 用户生成图
- WebUI 大包源码
- API Key

## Provider 配置

Web 设置页支持新增、编辑、启用、测试和删除多个大语言模型 Provider。配置保存在本机 `data/museforge.sqlite`，API Key 使用 `data/provider-secret.key` 加密保存，页面和 API 不回显明文。

没有 Web 配置时，后端会回退读取 `.env`。默认本地 Provider：

```text
AGENT_PROVIDER=local
AGENT_BASE_URL=http://127.0.0.1:11434/v1
AGENT_MODEL=gemma4:e4b
```


## Low Performance / VRAM-Saving Mode

Provider Settings includes a low-performance mode. Enable it when local Ollama models and A1111 checkpoints compete for VRAM.

With this mode enabled, the backend stops the active local Ollama model before image generation and unloads the A1111 checkpoint after the task finishes. The next request reloads the needed model on demand, so speed will be noticeably slower.

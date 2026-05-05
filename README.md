# SD Agent Studio

这是一个方便后续 vibe coding 的产品工程包：包含需求文档、高保真 UI 原型、后端 API 脚手架、模型 Provider 适配层和共享协议。仓库不包含模型权重和真实 API Key。

## 目录

```text
apps/
  backend/        后端 API 服务，负责任务编排、WebUI 调用、模型扫描
  ui-prototype/   高保真静态 UI 原型
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

一键拉取 ComfyUI / A1111 后端并安装基础依赖：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap-engines.ps1
```

Linux / macOS：

```bash
bash scripts/bootstrap-engines.sh
```

一键启动默认推理后端、Agent backend 和 UI：

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

导出产品图：

```bash
npm run export:screens
```

## 环境变量

复制 `.env.example` 为 `.env`，按需填写：

- `SD_WEBUI_BASE_URL`
- `INFERENCE_BACKEND`
- `COMFYUI_BASE_URL`
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
- ComfyUI / WebUI 大包源码
- API Key

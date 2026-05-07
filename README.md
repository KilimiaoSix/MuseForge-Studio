# MuseForge Studio

MuseForge Studio 是面向二次元创作者的本地优先创作客户端。它不替代 A1111 WebUI、Aki WebUI 或 ComfyUI，而是在这些引擎之上提供更适合产粮的提示词辅助、资源索引、配方管理、批量试验、资产沉淀和任务编排。

当前版本重点保持简单稳定：

- 使用 A1111 / Aki WebUI 执行单次 txt2img。
- 使用本地或 OpenAI-compatible LLM 生成 tag prompt 和基础参数。
- 保留 prompt-all-in-one 标签搜索能力。
- 不默认启用 Hires Fix、Extras upscale、ADetailer、视觉评分或多轮自动重试。

## 当前状态

已具备：

- React/Vite UI 原型。
- Node 后端 API。
- A1111 状态检查、模型扫描和 txt2img 调用。
- prompt tag 搜索和轻量生图规划。
- 任务队列、取消、重试和生成结果保存。
- Provider 配置和 Ollama 本地模型管理。
- checkpoint、LoRA、VAE、ControlNet、sampler 资源索引。
- ControlNet 与 LoRA 训练相关雏形接口。

下一阶段重点：

- Recipe 保存与复用。
- 批量抽卡和 seed 策略。
- 画廊筛选、收藏、淘汰、备注。
- 从生成结果恢复参数。
- 工作台围绕 Recipe 和资产重组。

## 文档

- [产品计划](docs/PRD-V1.md)
- [架构说明](docs/ARCHITECTURE.md)
- [Backend API](docs/API.md)
- [A1111 引擎部署](docs/ENGINE_SETUP.md)
- [项目地图](PROJECT_MAP.md)

## 项目结构

```text
apps/
  backend/          本地 API 服务，负责资源、Provider、任务和 A1111 调用
  ui-prototype/     React/Vite 前端原型
packages/
  model-providers/  LLM Provider 适配层
  shared/           共享 schema、默认值和归一化逻辑
docs/               产品、架构、API 和引擎部署资料
scripts/            开发、检查、A1111 和 Ollama 脚本
```

仓库不包含模型权重、WebUI 大包源码、真实 API Key 或用户生成图。

## 本地运行

安装依赖：

```bash
npm install
```

启动后端：

```bash
npm run dev:backend
```

启动 UI：

```bash
npm run dev:ui
```

默认地址：

- UI：`http://127.0.0.1:5177`
- Backend：`http://127.0.0.1:8787`
- A1111：`http://127.0.0.1:7860`

一键启动开发栈：

```bash
bash scripts/start-dev.sh
```

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-dev.ps1
```

## A1111 / Aki WebUI

如果你已经有可用 WebUI，只需要在 `.env` 中设置：

```text
A1111_BASE_URL=http://127.0.0.1:7860
SD_WEBUI_BASE_URL=http://127.0.0.1:7860
```

也可以使用脚本安装到 `vendor/engines/stable-diffusion-webui`：

```bash
bash scripts/bootstrap-engines.sh
```

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap-engines.ps1
```

更多说明见 [A1111 引擎部署](docs/ENGINE_SETUP.md)。

## Provider 配置

复制 `.env.example` 为 `.env`，按需填写：

```text
AGENT_PROVIDER=local
AGENT_BASE_URL=http://127.0.0.1:11434/v1
AGENT_MODEL=gemma4:e4b
AGENT_API_KEY=
```

Web 设置页也支持新增、启用、测试和删除 Provider。配置保存在本机 SQLite，API Key 会本地加密保存，接口不会回显明文。

## 检查

```bash
npm run check
```

## 不要提交

- `.env`
- 模型权重：`.safetensors`、`.ckpt`、`.pt`、`.pth`、`.gguf`
- 用户生成图
- WebUI 大包源码
- API Key

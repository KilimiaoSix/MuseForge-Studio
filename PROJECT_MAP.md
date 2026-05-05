# Project Map

## Product

- `docs/PRD-V1.md` - 产品需求文档。
- `screens/` - 7 张高保真 UI 产品图。
- `apps/ui-prototype/prototype/index.html` - 静态 UI 原型入口。

## Backend

- `apps/backend/src/server.js` - Node HTTP API scaffold。
- `apps/backend/src/engines.js` - ComfyUI / A1111 后端选择、状态、模型和生图调用。
- `apps/backend/examples/` - API 请求示例。
- `docs/API.md` - 后端接口草案。

## Inference Engines

- `engines/manifest.json` - ComfyUI / A1111 Git 仓库、端口、健康检查和模型目录配置。
- `vendor/engines/.gitkeep` - 大后端克隆位置。实际 ComfyUI / A1111 目录不会提交。
- `scripts/bootstrap-engines.ps1` - 一键拉取并安装推理后端。
- `scripts/start-dev.ps1` - 一键启动 Agent + UI + 默认推理后端。
- `scripts/*.sh` - Linux/macOS 对应脚本。

## Model Calling

- `packages/model-providers/src/index.js` - Provider 适配层。
- 支持 mock、OpenAI-compatible、OpenAI、本地网关、Anthropic/Claude 类接口。
- 不包含模型权重，不保存 API Key。

## Shared Contracts

- `packages/shared/src/index.js` - `GenerationPlan`、`EditPlan`、`LoraTrainingPlan` 默认值和归一化。
- `packages/shared/examples/generation-plan.json` - 生图方案示例。

## Local Run

```bash
npm install
npm run check
npm run dev:backend
npm run dev:ui
powershell -ExecutionPolicy Bypass -File scripts/bootstrap-engines.ps1
powershell -ExecutionPolicy Bypass -File scripts/start-dev.ps1
bash scripts/bootstrap-engines.sh
bash scripts/start-dev.sh
```

## Next Implementation Target

Start with:

```text
Connect apps/ui-prototype to apps/backend /api/generate/plan,
then wire /api/generate/run to a running Aki / AUTOMATIC1111 WebUI.
```

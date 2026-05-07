# Project Map

## Product Docs

- `docs/PRD-V1.md` - 当前产品计划：定位、已有能力、差距、路线图和下一阶段排期。
- `docs/ARCHITECTURE.md` - 当前运行架构、组件边界和下一阶段架构重点。
- `docs/API.md` - 当前后端 API 和下一阶段 Recipe API 预留。
- `docs/ENGINE_SETUP.md` - A1111 / Aki WebUI、Ollama 和本地运行说明。

## Apps

- `apps/backend/src/server.js` - 本地 HTTP API 入口。
- `apps/backend/src/engines.js` - A1111 / Aki WebUI 状态、模型扫描和生图调用。
- `apps/backend/src/tasks.js` - 任务队列、A1111 txt2img 执行和结果保存。
- `apps/backend/src/db.js` - SQLite 数据访问。
- `apps/ui-prototype/src/main.jsx` - React UI 原型。
- `apps/ui-prototype/src/styles.css` - UI 样式。

## Packages

- `packages/shared/src/index.js` - `GenerationPlan`、`EditPlan`、`LoraTrainingPlan` 和归一化逻辑。
- `packages/model-providers/src/index.js` - LLM Provider 适配层。

## Runtime And Scripts

- `scripts/start-dev.sh` / `scripts/start-dev.ps1` - 启动本地开发栈。
- `scripts/bootstrap-engines.sh` / `scripts/bootstrap-engines.ps1` - 拉取并准备 A1111。
- `scripts/check-engines.sh` / `scripts/check-engines.ps1` - 检查本地引擎。
- `vendor/engines/` - A1111 等大体积后端安装目录，不提交源码。
- `outputs/` - 用户生成结果目录，不提交内容。

## Next Implementation Target

P1 优先做 Recipe 与批量抽卡：

1. 定义 Recipe / RecipeSnapshot / GenerationGroup。
2. 新增 Recipe CRUD API。
3. 任务与生成结果保存 recipe 快照。
4. UI 工作台支持保存、复用、批量生成和结果筛选。

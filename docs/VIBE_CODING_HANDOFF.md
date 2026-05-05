# Vibe Coding 交接说明

## 你可以把这个目录整体丢给其他平台

建议上传：

- `apps/`
- `packages/`
- `docs/`
- `prototype/` 或 `apps/ui-prototype/`
- `screens/`
- `package.json`
- `.env.example`

不要上传：

- `.env`
- 模型权重
- `models/`
- WebUI 大包
- 用户生成图片
- API Key

## 推荐开发顺序

1. 先跑通 `apps/backend` 的 mock API。
2. 接入本地 WebUI 的 `/sdapi/v1/txt2img`。
3. 接入一个 OpenAI-compatible Provider。
4. 把静态 UI 改成真实前端，调用后端。
5. 再补智能改图和 LoRA 炼制接口。

## 跨平台引擎脚本

Windows 使用：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap-engines.ps1
powershell -ExecutionPolicy Bypass -File scripts/start-dev.ps1
```

Linux / macOS 使用：

```bash
bash scripts/bootstrap-engines.sh
bash scripts/start-dev.sh
```

## 第一轮可交给 coding agent 的任务

```text
基于 apps/backend 和 packages/shared 的 schema，实现 /api/generate/plan：
输入中文自然语言，调用 OpenAI-compatible Provider，返回 GenerationPlan。
如果 Provider 未配置，返回 mock plan。
```

## 第二轮任务

```text
实现 /api/generate/run：
接收 GenerationPlan，转换为 AUTOMATIC1111 /sdapi/v1/txt2img 请求，
调用 SD_WEBUI_BASE_URL，返回图片 base64 和参数。
```

## 第三轮任务

```text
把 apps/ui-prototype 从静态 HTML 升级成 React/Vite 前端，
保留当前视觉布局，接入 /api/generate/plan 和 /api/generate/run。
```

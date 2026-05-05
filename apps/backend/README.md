# Backend API

Lightweight Node.js backend scaffold for SD Agent Studio.

## Run

```bash
npm install
npm run dev:backend
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

## Endpoints

- `GET /health`
- `GET /api/engines/status`
- `GET /api/engines/models`
- `GET /api/models/local`
- `POST /api/generate/plan`
- `POST /api/generate/run`
- `POST /api/lora/plan`

## Notes

- Model weights are not included.
- API keys are read from environment variables.
- Real image generation requires ComfyUI or Aki / AUTOMATIC1111 WebUI running.
- Use `INFERENCE_BACKEND=comfyui` or `INFERENCE_BACKEND=a1111` to switch engines.

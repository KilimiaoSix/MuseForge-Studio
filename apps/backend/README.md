# MuseForge Backend

Local Node.js API for MuseForge Studio. It coordinates Provider settings, prompt tag planning, local resources, generation tasks, A1111 / Aki WebUI calls, and saved outputs.

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
- `GET /api/prompt-tools/tags`
- `GET /api/engines/status`
- `GET /api/engines/models`
- `GET /api/models/local`
- `POST /api/generate/plan`
- `POST /api/tasks/generate`
- `GET /api/tasks`
- `GET /api/generations`
- `GET /api/providers`
- `POST /api/lora/plan`

## Notes

- Model weights are not included.
- API keys are stored locally through Provider settings or read from `.env` as fallback.
- Current real image generation requires A1111 / Aki WebUI running.
- ComfyUI and cloud engine routing are future work.

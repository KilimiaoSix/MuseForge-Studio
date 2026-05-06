#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

PORT="${COMFYUI_PORT:-8188}"
HOST_ADDRESS="${COMFYUI_HOST:-127.0.0.1}"
ENGINE_PATH="$ROOT/vendor/engines/ComfyUI"
PYTHON="$ENGINE_PATH/.venv/bin/python"

if [[ ! -d "$ENGINE_PATH" ]]; then
  echo "ComfyUI is not installed. Run scripts/bootstrap-engines.sh first." >&2
  exit 1
fi

if [[ ! -x "$PYTHON" ]]; then
  echo "ComfyUI venv not found. Run scripts/bootstrap-engines.sh first." >&2
  exit 1
fi

cd "$ENGINE_PATH"
exec "$PYTHON" main.py --listen "$HOST_ADDRESS" --port "$PORT"

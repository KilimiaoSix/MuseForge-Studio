#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

PORT="${A1111_PORT:-7860}"
ENGINE_PATH="${SD_WEBUI_ROOT:-$ROOT/vendor/engines/stable-diffusion-webui}"
WEBUI_SH="$ENGINE_PATH/webui.sh"
TAMING_PATH="$ENGINE_PATH/repositories/taming-transformers"

: "${HF_ENDPOINT:=https://hf-mirror.com}"
export HF_ENDPOINT
: "${PYTORCH_ENABLE_MPS_FALLBACK:=1}"
export PYTORCH_ENABLE_MPS_FALLBACK

if [[ ! -f "$WEBUI_SH" ]]; then
  echo "A1111 WebUI is not installed. Run scripts/bootstrap-engines.sh first or copy it to vendor/engines/stable-diffusion-webui." >&2
  exit 1
fi

cd "$ENGINE_PATH"
chmod +x "$WEBUI_SH"
if [[ -d "$TAMING_PATH" ]]; then
  export PYTHONPATH="${TAMING_PATH}${PYTHONPATH:+:$PYTHONPATH}"
fi
exec "$WEBUI_SH" --api --listen --port "$PORT" --no-download-sd-model

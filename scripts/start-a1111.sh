#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${A1111_PORT:-7860}"
ENGINE_PATH="$ROOT/vendor/engines/stable-diffusion-webui"
WEBUI_SH="$ENGINE_PATH/webui.sh"

if [[ ! -f "$WEBUI_SH" ]]; then
  echo "A1111 WebUI is not installed. Run scripts/bootstrap-engines.sh first." >&2
  exit 1
fi

cd "$ENGINE_PATH"
chmod +x "$WEBUI_SH"
exec "$WEBUI_SH" --api --listen --port "$PORT"


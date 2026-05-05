#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE="${INFERENCE_BACKEND:-comfyui}"

case "$ENGINE" in
  comfyui|a1111)
    ;;
  *)
    echo "Unsupported INFERENCE_BACKEND: $ENGINE" >&2
    echo "Use comfyui or a1111." >&2
    exit 1
    ;;
esac

start_background() {
  local name="$1"
  shift
  echo "Starting $name..."
  (cd "$ROOT" && "$@") >"$ROOT/logs/${name}.log" 2>&1 &
  echo "$!" >"$ROOT/logs/${name}.pid"
}

mkdir -p "$ROOT/logs"

if [[ "$ENGINE" == "comfyui" ]]; then
  start_background "comfyui" bash scripts/start-comfyui.sh
else
  start_background "a1111" bash scripts/start-a1111.sh
fi

start_background "backend" env INFERENCE_BACKEND="$ENGINE" npm run dev:backend
start_background "ui-prototype" npm run dev:ui

echo "Dev stack starting."
echo "Backend: http://127.0.0.1:8787"
echo "UI:      http://127.0.0.1:5177"
echo "Engine:  $ENGINE"
echo "Logs:    $ROOT/logs"


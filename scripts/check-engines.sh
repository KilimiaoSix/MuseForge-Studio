#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

check_command() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    echo "tool $name: ok"
  else
    echo "tool $name: missing"
  fi
}

check_port() {
  local port="$1"
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1 && echo "open" || echo "closed"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$port" <<'PY'
import socket, sys
port = int(sys.argv[1])
s = socket.socket()
s.settimeout(0.7)
try:
    s.connect(("127.0.0.1", port))
    print("open")
except Exception:
    print("closed")
finally:
    s.close()
PY
  else
    echo "unknown"
  fi
}

check_http() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 3 "$url" >/dev/null 2>&1 && echo "ok" || echo "down"
  else
    echo "unknown"
  fi
}

echo "Tool checks"
check_command git
check_command node
check_command npm
check_command "${PYTHON_EXE:-python3}"

echo
echo "Engine checks"

COMFY_PATH="$ROOT/vendor/engines/ComfyUI"
A1111_PATH="$ROOT/vendor/engines/stable-diffusion-webui"

echo "comfyui.installed=$([[ -d "$COMFY_PATH" ]] && echo true || echo false)"
echo "comfyui.path=$COMFY_PATH"
echo "comfyui.port=8188"
echo "comfyui.portOpen=$(check_port 8188)"
echo "comfyui.health=$(check_http "${COMFYUI_BASE_URL:-http://127.0.0.1:8188}/system_stats")"

echo
echo "a1111.installed=$([[ -d "$A1111_PATH" ]] && echo true || echo false)"
echo "a1111.path=$A1111_PATH"
echo "a1111.port=7860"
echo "a1111.portOpen=$(check_port 7860)"
echo "a1111.health=$(check_http "${A1111_BASE_URL:-http://127.0.0.1:7860}/sdapi/v1/sd-models")"


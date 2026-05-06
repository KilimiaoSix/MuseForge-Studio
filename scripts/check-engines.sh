#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

check_command() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    echo "$name=true"
  else
    echo "$name=false"
  fi
}

check_port() {
  local port="$1"
  if command -v nc >/dev/null 2>&1; then
    nc -z 127.0.0.1 "$port" >/dev/null 2>&1 && echo true || echo false
  else
    (echo >"/dev/tcp/127.0.0.1/$port") >/dev/null 2>&1 && echo true || echo false
  fi
}

check_http() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 3 "$url" >/dev/null 2>&1 && echo true || echo false
  else
    echo false
  fi
}

A1111_PATH="$ROOT/vendor/engines/stable-diffusion-webui"
A1111_URL="${A1111_BASE_URL:-http://127.0.0.1:7860}/sdapi/v1/sd-models"

echo "tool.git=$(check_command git | cut -d= -f2)"
echo "tool.node=$(check_command node | cut -d= -f2)"
echo "tool.npm=$(check_command npm | cut -d= -f2)"
echo
echo "a1111.installed=$([[ -d "$A1111_PATH" ]] && echo true || echo false)"
echo "a1111.path=$A1111_PATH"
echo "a1111.port=7860"
echo "a1111.portOpen=$(check_port 7860)"
echo "a1111.health=$(check_http "$A1111_URL")"
echo "a1111.healthUrl=$A1111_URL"

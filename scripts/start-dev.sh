#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

start_background() {
  local name="$1"
  shift
  echo "Starting $name..."
  nohup "$@" > "logs/$name.log" 2>&1 &
}

mkdir -p logs

start_background "a1111" bash scripts/start-a1111.sh
start_background "backend" npm run dev:backend
start_background "ui" npm run dev:ui

echo "Dev stack starting."
echo "Backend: http://127.0.0.1:8787"
echo "UI:      http://127.0.0.1:5177"
echo "Engine:  a1111"

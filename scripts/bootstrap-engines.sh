#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

INSTALL_DIR="${ENGINE_INSTALL_DIR:-vendor/engines}"
SKIP_INSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-install)
      SKIP_INSTALL=1
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 1; }

mkdir -p "$ROOT/$INSTALL_DIR"

sync_repo() {
  local name="$1"
  local repo_url="$2"
  local branch="$3"
  local target="$4"

  if [[ -d "$target" ]]; then
    echo "[$name] already exists: $target"
    if [[ -d "$target/.git" ]]; then
      git -C "$target" fetch --all --prune
      git -C "$target" checkout "$branch"
      git -C "$target" pull --ff-only
    fi
  else
    echo "Cloning $name -> $target"
    git clone --branch "$branch" "$repo_url" "$target"
  fi
}

install_a1111() {
  local target="$1"
  [[ "$SKIP_INSTALL" == "1" ]] && return 0
  echo "[A1111] Dependencies are installed by webui.sh on first start."
  echo "[A1111] Path: $target"
}

A1111_REPO_URL="${A1111_REPO_URL:-https://github.com/AUTOMATIC1111/stable-diffusion-webui.git}"
A1111_PATH="$ROOT/$INSTALL_DIR/stable-diffusion-webui"

sync_repo "A1111 WebUI" "$A1111_REPO_URL" "master" "$A1111_PATH"
install_a1111 "$A1111_PATH"

echo "A1111 bootstrap complete."
echo "Model weights are not downloaded. Place checkpoints in vendor/engines/stable-diffusion-webui/models/Stable-diffusion manually."

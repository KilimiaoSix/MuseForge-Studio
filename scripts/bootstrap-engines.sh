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
PYTHON_EXE="${PYTHON_EXE:-python3}"
COMFY_ONLY=0
A1111_ONLY=0
SKIP_INSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --comfy-only)
      COMFY_ONLY=1
      shift
      ;;
    --a1111-only)
      A1111_ONLY=1
      shift
      ;;
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
command -v "$PYTHON_EXE" >/dev/null 2>&1 || { echo "$PYTHON_EXE is required" >&2; exit 1; }

mkdir -p "$ROOT/$INSTALL_DIR"

sync_repo() {
  local name="$1"
  local repo_url="$2"
  local branch="$3"
  local target="$4"

  if [[ -d "$target/.git" ]]; then
    echo "[$name] already exists: $target"
    git -C "$target" fetch --all --prune
    git -C "$target" checkout "$branch"
    git -C "$target" pull --ff-only
  else
    echo "Cloning $name -> $target"
    git clone --branch "$branch" "$repo_url" "$target"
  fi
}

install_comfyui() {
  local target="$1"
  [[ "$SKIP_INSTALL" == "1" ]] && return 0
  if [[ ! -d "$target/.venv" ]]; then
    "$PYTHON_EXE" -m venv "$target/.venv"
  fi
  "$target/.venv/bin/python" -m pip install --upgrade pip
  "$target/.venv/bin/python" -m pip install -r "$target/requirements.txt"
}

install_a1111() {
  local target="$1"
  [[ "$SKIP_INSTALL" == "1" ]] && return 0
  echo "[A1111] Dependencies are installed by webui.sh on first start."
  echo "[A1111] Path: $target"
}

COMFY_REPO_URL="${COMFYUI_REPO_URL:-https://github.com/comfyanonymous/ComfyUI.git}"
A1111_REPO_URL="${A1111_REPO_URL:-https://github.com/AUTOMATIC1111/stable-diffusion-webui.git}"

if [[ "$A1111_ONLY" != "1" ]]; then
  COMFY_PATH="$ROOT/$INSTALL_DIR/ComfyUI"
  sync_repo "ComfyUI" "$COMFY_REPO_URL" "master" "$COMFY_PATH"
  install_comfyui "$COMFY_PATH"
fi

if [[ "$COMFY_ONLY" != "1" ]]; then
  A1111_PATH="$ROOT/$INSTALL_DIR/stable-diffusion-webui"
  sync_repo "A1111 WebUI" "$A1111_REPO_URL" "master" "$A1111_PATH"
  install_a1111 "$A1111_PATH"
fi

echo "Engine bootstrap complete."
echo "Model weights are not downloaded. Place checkpoints in the engine model folders manually."

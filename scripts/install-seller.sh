#!/usr/bin/env bash
set -euo pipefail

GATEWAY=""
ARGS=("$@")

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gateway)
      GATEWAY="${2:-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

if [[ -z "$GATEWAY" ]]; then
  echo "ERROR: --gateway is required" >&2
  echo "Usage: ./scripts/install-seller.sh --gateway https://api.subi.example --setup-token subi_setup_xxx --agent-path ./dist/seller-agent" >&2
  exit 2
fi

GATEWAY="${GATEWAY%/}"
exec bash -c "$(curl -fsSL "$GATEWAY/api/v1/subi/seller/install.sh")" -- "${ARGS[@]}"

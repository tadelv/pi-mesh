#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm install
pnpm -r build
exec pnpm --filter @pi-mesh/control-plane dev

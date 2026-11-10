#!/usr/bin/env bash
# Builds the control plane image with the commit it came from stamped into it.
#
# Nothing in the image used to name its source, and the 2026-11-07 deployment
# turned out to be an uncommitted tree (a commit plus one later fix), so the
# only way to identify it was to hash the copied source against git history.
# This refuses that trade: a dirty tree cannot be built without --allow-dirty.
#
# Build on the machine that will run it where possible. apollo is linux/amd64;
# an arm64 Mac must pass --platform=linux/amd64 and pay for emulation.
set -euo pipefail
cd "$(dirname "$0")/.."

allow_dirty=false
platform_args=()
for arg in "$@"; do
  case "$arg" in
    --allow-dirty) allow_dirty=true ;;
    --platform=*) platform_args=(--platform "${arg#--platform=}") ;;
    *)
      echo "usage: $0 [--allow-dirty] [--platform=linux/amd64]" >&2
      exit 2
      ;;
  esac
done

dirty=$(git status --porcelain)
if [ -n "$dirty" ] && [ "$allow_dirty" = false ]; then
  echo "refusing to build from a dirty tree: commit the work, or pass --allow-dirty" >&2
  echo "$dirty" | sed 's/^/  /' >&2
  exit 1
fi
if [ -n "$dirty" ]; then
  echo "warning: dirty tree; the revision stamped below does not describe this image" >&2
fi

sha=$(git rev-parse HEAD)
docker build ${platform_args[@]+"${platform_args[@]}"} \
  --build-arg "GIT_SHA=$sha" \
  -f packages/control-plane/Dockerfile \
  -t pi-mesh/control-plane:dev \
  .

id=$(docker image inspect pi-mesh/control-plane:dev --format '{{.Id}}')
revision=$(docker image inspect pi-mesh/control-plane:dev --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
arch=$(docker image inspect pi-mesh/control-plane:dev --format '{{.Architecture}}')
echo "built ${id:0:19} (${arch}), revision ${revision}" >&2
cat <<'NEXT'
next: ship it to the host that runs it, then redeploy the control-plane stack so
the container is recreated on the new tag:
  docker save pi-mesh/control-plane:dev | ssh <host> docker load
NEXT

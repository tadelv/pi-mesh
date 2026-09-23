# syntax=docker/dockerfile:1

# Builds and runs the pi-mesh control plane.
#
# This is the M0-9 placeholder: the image exists to prove the workspace
# packages a pnpm monorepo correctly, so the default command prints usage and
# exits 0. Real deployment overrides it with `publish`.
FROM node:22-alpine

# Tracks the pnpm version pinned in package.json's packageManager field.
RUN corepack enable

WORKDIR /app

# Copied before install so the dependency layer is cached independently of
# source edits. .dockerignore keeps host node_modules and dist out of the
# context; copying those in would poison the install with host binaries.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages ./packages

RUN pnpm install --frozen-lockfile
RUN pnpm -r build

ENV NODE_ENV=production

ENTRYPOINT ["node", "packages/control-plane/dist/cli.js"]
CMD ["serve"]

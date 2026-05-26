# Multi-stage build: TypeScript compile in builder, slim runtime with bundled tools.
# Runtime layer adds git + gh CLI + ripgrep + jq + yq for read-only repo exploration.
# Single Node process, no stdio bridge, no supergateway. SIGTERM reaches Node directly.

FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --production && npm cache clean --force

FROM node:22-alpine
WORKDIR /app

# Bundled binaries — read-only exploration toolbox.
# git: clone subprocess
# github-cli: gh api wrapper (PAT-authenticated GET-only)
# ripgrep: grep tool
# jq: JSON query tool
# yq: YAML/XML/TOML/etc query tool (mikefarah's go yq, NOT python yq)
RUN apk add --no-cache git github-cli ripgrep jq yq

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json

EXPOSE 8000
ENTRYPOINT ["node", "dist/index.js"]

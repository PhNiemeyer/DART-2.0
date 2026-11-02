# DART 2.0 – Container für API, Vault, Worker, Migration (Stage "app") und Web (Stage "web").
# Basisimage über IMAGE_MIRROR austauschbar (Standard: Docker Hub).
ARG IMAGE_MIRROR=docker.io
FROM ${IMAGE_MIRROR}/library/node:22-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@10.28.0
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages packages
COPY apps apps
COPY migrations migrations
COPY tests/e2e/package.json tests/e2e/package.json
RUN pnpm install --frozen-lockfile
RUN pnpm -r --filter "./packages/**" run build \
 && pnpm --filter @dart/vault --filter @dart/api --filter @dart/worker run build \
 && pnpm --filter @dart/web run build

FROM ${IMAGE_MIRROR}/library/node:22-alpine AS app
ENV NODE_ENV=production
WORKDIR /repo
RUN addgroup -S dart && adduser -S dart -G dart
COPY --from=build --chown=dart:dart /repo /repo
USER dart

FROM ${IMAGE_MIRROR}/library/node:22-alpine AS web
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
RUN addgroup -S dart && adduser -S dart -G dart
COPY --from=build --chown=dart:dart /repo/apps/web/.next/standalone ./
COPY --from=build --chown=dart:dart /repo/apps/web/.next/static ./apps/web/.next/static
USER dart
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

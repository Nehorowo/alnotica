# Multi-stage build. The final image carries `dist` and production dependencies
# only: no sources, no devDependencies, no toolchain.

# ---------------------------------- deps ------------------------------------
FROM node:24-alpine AS deps
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/miniapp/package.json apps/miniapp/

RUN pnpm install --frozen-lockfile

# ---------------------------------- build -----------------------------------
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps ./apps
COPY . .

RUN pnpm exec turbo run build

# Strip the toolchain: reinstall with production dependencies only, so the layer
# copied into the runtime stage carries nothing that is not needed at run time.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# --------------------------------- runtime ----------------------------------
FROM node:24-alpine AS runtime
WORKDIR /app

# Scheduling arithmetic must never depend on the machine's zone. UTC everywhere
# means an accidental dependency on the system clock fails loudly in development
# instead of quietly in production.
ENV TZ=UTC
ENV NODE_ENV=production

RUN apk add --no-cache tzdata postgresql16-client aws-cli bash curl \
  && addgroup -g 1001 -S alnotica \
  && adduser -u 1001 -S alnotica -G alnotica

COPY --from=build --chown=alnotica:alnotica /app/node_modules ./node_modules
COPY --from=build --chown=alnotica:alnotica /app/package.json ./package.json

COPY --from=build --chown=alnotica:alnotica /app/packages/shared/package.json ./packages/shared/
COPY --from=build --chown=alnotica:alnotica /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=alnotica:alnotica /app/packages/core/package.json ./packages/core/
COPY --from=build --chown=alnotica:alnotica /app/packages/core/dist ./packages/core/dist
COPY --from=build --chown=alnotica:alnotica /app/packages/db/package.json ./packages/db/
COPY --from=build --chown=alnotica:alnotica /app/packages/db/dist ./packages/db/dist
# The SQL migrations are data, not code, and are read at boot.
COPY --from=build --chown=alnotica:alnotica /app/packages/db/migrations ./packages/db/migrations

COPY --from=build --chown=alnotica:alnotica /app/apps/api/package.json ./apps/api/
COPY --from=build --chown=alnotica:alnotica /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=alnotica:alnotica /app/apps/worker/package.json ./apps/worker/
COPY --from=build --chown=alnotica:alnotica /app/apps/worker/dist ./apps/worker/dist
COPY --from=build --chown=alnotica:alnotica /app/apps/miniapp/dist ./apps/miniapp/dist

COPY --chown=alnotica:alnotica ops/backup.sh ops/restore.sh ./ops/

USER alnotica
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "apps/api/dist/main.js"]

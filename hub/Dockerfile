# Build context is the REPO ROOT, not hub/ — the hub depends on
# @cpe310/contracts via `workspace:*`, so pnpm needs the workspace manifest and
# that package's source. Compose sets `context: .` with `dockerfile: ./hub/Dockerfile`.
#
#   docker build -f hub/Dockerfile -t cpe310-hub .

# ---------------------------------------------------------------- deps
FROM node:24-alpine AS deps
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo

# Manifests only, so a source-only change reuses this layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/contracts/package.json packages/contracts/
COPY hub/package.json hub/

# `hub...` means hub plus its workspace dependencies.
RUN pnpm install --frozen-lockfile --filter hub...

# ---------------------------------------------------------------- build
FROM deps AS build
WORKDIR /repo
COPY packages/ packages/
COPY hub/ hub/

# Generate before compiling: the hub's TS imports types from the Prisma client.
# (This copy of the client is for the type-check only — see the runtime stage,
# which regenerates it because `pnpm deploy` does not carry it over.)
RUN pnpm --filter hub exec prisma generate \
  && pnpm --filter @cpe310/contracts run build \
  && pnpm --filter hub run build

# Strip dev dependencies from what gets copied into the runtime image.
RUN pnpm --filter hub --prod deploy /deploy

# ---------------------------------------------------------------- runtime
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# `prisma migrate deploy` needs the CLI, which is a devDependency and so absent
# from the pruned deploy. Installing it globally here keeps it out of the build
# image's dependency graph while still available to the entrypoint.
RUN apk add --no-cache openssl \
  && npm install -g prisma@6.19.3 \
  && npm cache clean --force

COPY --from=build /deploy/node_modules ./node_modules
COPY --from=build /deploy/dist ./dist
COPY --from=build /deploy/package.json ./package.json
COPY --from=build /repo/hub/prisma ./prisma
COPY --chmod=0755 hub/docker-entrypoint.sh ./docker-entrypoint.sh

# Regenerate the Prisma client here, in the image that will actually run it.
# `pnpm deploy` rebuilds node_modules from the content-addressable store, which
# restores @prisma/client to its published state and discards the generated query
# engine written during the build stage — so without this the hub dies at boot with
# "@prisma/client did not initialize yet".
#
# DATABASE_URL is supplied inline only to satisfy the schema's datasource block;
# generate never connects, and the placeholder does not persist into the image env.
RUN DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder \
  prisma generate --schema=./prisma/schema.prisma

# `node` (uid 1000) ships with the base image; running as root would let a
# compromised hub write to mounted volumes.
USER node

EXPOSE 3000

# The hub is useless without Postgres, and /health returns 503 when the DB is
# unreachable — so this gates the agents on a genuinely working hub.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["./docker-entrypoint.sh"]

# Build context is the REPO ROOT — the dashboard depends on @cpe310/contracts via
# `workspace:*`, so pnpm needs the workspace manifest and that package's source.
#
#   docker build -f dashboard/Dockerfile -t cpe310-web .
#
# The final image is Caddy, not a Node server: the dashboard is static files after the
# build, so shipping a Node runtime to serve them would be pure overhead. Caddy serves
# them AND reverse-proxies the hub, so the whole app is one origin and CORS never
# enters the picture.

# ---------------------------------------------------------------- deps
# Node 22 to match .nvmrc, the hub image, and what hosted pipelines support.
FROM node:22-alpine AS deps

# No version argument: corepack reads `packageManager` from package.json, so the pnpm
# version is defined in exactly one place.
RUN corepack enable
WORKDIR /repo

# Manifests only, so a source-only change reuses this layer.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/contracts/package.json packages/contracts/
COPY dashboard/package.json dashboard/

# `dashboard...` means the dashboard plus its workspace dependencies.
RUN pnpm install --frozen-lockfile --filter dashboard...

# ---------------------------------------------------------------- build
FROM deps AS build
WORKDIR /repo
COPY packages/ packages/
COPY dashboard/ dashboard/

# Baked in at build time — Vite substitutes import.meta.env during the build, so a
# built bundle cannot be repointed at another hub without rebuilding. Left empty for
# the proxied setup, where same-origin defaults apply; set them for a split deployment
# such as Render.
ARG VITE_API_BASE=""
ARG VITE_WS_URL=""
ENV VITE_API_BASE=$VITE_API_BASE
ENV VITE_WS_URL=$VITE_WS_URL

RUN pnpm --filter @cpe310/contracts run build \
  && pnpm --filter dashboard run build

# ---------------------------------------------------------------- runtime
FROM caddy:2-alpine AS runtime

COPY --from=build /repo/dashboard/dist /srv
COPY deploy/Caddyfile /etc/caddy/Caddyfile

# 80 and 443 for the proxy; 443/udp carries HTTP/3, which Caddy enables by default.
EXPOSE 80 443 443/udp

# Fails if the Caddyfile is malformed, so a bad edit surfaces as an unhealthy container
# rather than a site that silently serves nothing.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1/ || exit 1

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

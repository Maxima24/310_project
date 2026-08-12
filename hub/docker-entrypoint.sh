#!/bin/sh
# Applies migrations, then starts the hub. Running migrations at container start
# (rather than at build time) means a fresh Postgres volume self-provisions on the
# first `docker compose up` with no manual step.
set -e

echo "Applying database migrations..."
# `migrate deploy` only applies committed migrations and never prompts or resets —
# the correct choice for a container. `migrate dev` would be destructive here.
prisma migrate deploy --schema=./prisma/schema.prisma

echo "Starting hub..."
exec node dist/main.js

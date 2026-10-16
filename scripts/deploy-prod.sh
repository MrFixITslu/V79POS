#!/bin/sh
set -eu

ENV_FILE="${ENV_FILE:-.env}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE. Copy .env.production.example to .env and replace every placeholder." >&2
  exit 1
fi

if grep -Eiq '=(REPLACE_|change[_-]?me|replace-with)' "$ENV_FILE"; then
  echo "Deployment blocked: placeholder secrets remain in $ENV_FILE." >&2
  exit 1
fi

proxy_network="${PROXY_NETWORK:-$(sed -n 's/^PROXY_NETWORK=//p' "$ENV_FILE" | tail -1)}"
proxy_network="${proxy_network:-proxy_network}"

if ! docker network inspect "$proxy_network" >/dev/null 2>&1; then
  echo "Required Docker network '$proxy_network' does not exist." >&2
  echo "Create it first with: docker network create $proxy_network" >&2
  exit 1
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config >/dev/null
# Verify the effective rendered Compose configuration before image builds, DB
# migration or any production service replacement. This prints no secrets.
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --format json | node scripts/pos-release-preflight.mjs
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build --pull
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d postgres redis

# A healthy pg_isready only means PostgreSQL accepts connections. An existing
# data volume retains its original role password even when .env is changed.
if ! printf 'SELECT 1;\n' | docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps -T migrate ./node_modules/.bin/prisma db execute --schema prisma/schema.prisma --stdin >/dev/null 2>&1; then
  echo "POS database authentication or migration status check failed." >&2
  echo "If POSTGRES_PASSWORD was changed after the volume was created, run ./scripts/repair-server.sh to synchronize the existing role without deleting data." >&2
  echo "Check the database and migration logs before retrying deployment." >&2
  exit 1
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d

echo
echo "V79 POS services:"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
echo
echo "Nginx Proxy Manager: pos.v79sl.com -> http://v79-pos:8080 on $proxy_network"

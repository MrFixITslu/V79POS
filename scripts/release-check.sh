#!/bin/sh
set -eu
if ! find prisma/migrations -mindepth 2 -maxdepth 2 -name migration.sql | grep -q .; then
  echo "RELEASE BLOCKED: no Prisma migration.sql is committed." >&2
  echo "Generate and validate the baseline migration with ./scripts/prepare-baseline-migration.sh" >&2
  exit 2
fi
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:validate
node --check apps/api/public/app.js
pnpm build
pnpm test
pnpm lint
printf 'Release checks passed.\n'

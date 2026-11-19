# Prisma migration gate

The repository contains a baseline and additive migrations for technician stock,
lot quarantine and Hub organisation-name synchronisation. Treat the migration
files and their recorded checksums as release history; do not regenerate or edit
an already applied migration.

Validate the schema and application without touching production:

```bash
pnpm install
pnpm db:generate
pnpm db:validate
pnpm build
pnpm test
```

The normal API test command excludes the PostgreSQL-only QA file. It remains a
separate required release gate. On an isolated PostgreSQL 17 database named
`hubqa`, reachable only on localhost inside the QA network namespace:

```bash
DATABASE_URL='<disposable-localhost-hubqa>' pnpm prisma migrate deploy
# With NODE_ENV=test and dedicated synthetic signing keys:
V79_POS_ORG_SYNC_QA=1 pnpm --filter @v79/commerce-api test:postgres:org-sync
V79_POS_LOT_QA=1 pnpm --filter @v79/commerce-api exec tsx qa/lot-quarantine.postgres.qa.ts
V79_POS_TECH_QA=1 pnpm --filter @v79/commerce-api exec tsx qa/technician-workflow.postgres.qa.ts
```

Before an existing production database is upgraded, inspect its actual
`_prisma_migrations` history and schema, verify applied checksums, take an
encrypted checkpoint, and rehearse the pending migrations on a restored isolated
copy. Never run `migrate dev`, `db push`, `reset` or a replacement baseline against
production. Do not recreate the live PostgreSQL or Redis containers as part of an
application image rollout.

Rollback needs special care after the new quarantine field is used. Older code
does not enforce the per-lot quarantine rules. An old image is not an acceptable
rollback for newly quarantined stock; retain the current data and use a tested
compatible recovery image or keep affected writes unavailable during recovery.

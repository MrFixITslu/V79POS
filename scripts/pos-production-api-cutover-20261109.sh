#!/usr/bin/env bash
# V79 POS: exact tested image -> production API only; no production db/worker restart.
# Requires a freshly verified off-host encrypted PostgreSQL backup SHA-256 as arg 1.
set -Eeuo pipefail
umask 077

fail() { printf 'POS_RELEASE_BLOCKED=%s\n' "$1" >&2; exit 1; }
require() { "$@" || fail "precondition_failed"; }
BACKUP_SHA="${1:-}"
[[ "$BACKUP_SHA" =~ ^[0-9a-fA-F]{64}$ ]] || fail "offhost_backup_witness_missing"
[[ "$(hostname -s)" == "v79sl" ]] || fail "unexpected_docker_host"

OLD_TAG='localhost/v79-brand-pos:20261106-r1'
OLD_ID='sha256:7103df9054b3433217d01f44f8495336b4ed8b55314217db9cb1167e98a186b6'
STAGE_TAG='v79pos:hubqa-2590623'
STAGE_ID='sha256:9a1abea699f8f750feb21b2f53e5973389442a6be1ba945293913af973bf2433'
NEW_TAG='localhost/v79-pos:technician-stock-20261109-r1'
WORKDIR='/home/firelion/v79-remaining-rollout.GCIN6i1p'
FIRST="$WORKDIR/v79-pos-original.pinned.yml"
SECOND='/home/firelion/vision79-pos-ui-hotfix-0b19aaa0e420/compose.ui-only.override.yaml'
THIRD='/home/firelion/v79-pos-release.hjyiubje/api-image.yml'
RELEASE_DIR='/home/firelion/v79-pos-technician-release-20261109'
RELEASE_OVERLAY="$RELEASE_DIR/api-release.yml"
ROLLBACK_OVERLAY="$RELEASE_DIR/api-rollback.yml"

[[ -f "$FIRST" && -f "$SECOND" && -f "$THIRD" && -d "$WORKDIR" ]] ||
    fail "original_compose_chain_missing"
[[ "$(docker inspect v79-pos --format '{{.Config.Image}}')" == "$OLD_TAG" ]] ||
    fail "live_image_tag_drift"
[[ "$(docker inspect v79-pos --format '{{.Image}}')" == "$OLD_ID" ]] ||
    fail "live_image_id_drift"
[[ "$(docker image inspect "$OLD_TAG" --format '{{.Id}}')" == "$OLD_ID" ]] ||
    fail "rollback_image_missing"
[[ "$(docker image inspect "$STAGE_TAG" --format '{{.Id}}')" == "$STAGE_ID" ]] ||
    fail "tested_candidate_image_drift"
[[ "$(docker inspect v79-pos --format '{{index .Config.Labels "com.docker.compose.project"}}')" == "v79pos" ]] ||
    fail "wrong_compose_project"
[[ "$(docker inspect v79-pos --format '{{index .Config.Labels "com.docker.compose.service"}}')" == "api" ]] ||
    fail "wrong_compose_service"
[[ "$(docker inspect v79-pos --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')" == "$WORKDIR" ]] ||
    fail "compose_directory_drift"
EXPECTED_FILES="$FIRST,$SECOND,$THIRD"
[[ "$(docker inspect v79-pos --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}')" == "$EXPECTED_FILES" ]] ||
    fail "live_compose_files_drift"

for name in v79-pos v79-pos-db v79-pos-redis v79-hub; do
    [[ "$(docker inspect "$name" --format '{{.State.Health.Status}}')" == "healthy" ]] ||
        fail "unhealthy_$name"
done

DB_ID="$(docker inspect v79-pos-db --format '{{.Id}}')"
REDIS_ID="$(docker inspect v79-pos-redis --format '{{.Id}}')"
WORKER_ID="$(docker inspect v79-pos-worker --format '{{.Id}}')"
HUB_ID="$(docker inspect v79-hub --format '{{.Id}}')"

install -d -m 700 "$RELEASE_DIR"
exec 9>"$RELEASE_DIR/.release.lock"
flock -n 9 || fail "release_already_in_progress"
[[ ! -e "$RELEASE_OVERLAY" && ! -e "$ROLLBACK_OVERLAY" ]] ||
    fail "release_override_already_exists"

cd "$WORKDIR"
BASE=(docker compose --project-directory "$WORKDIR" -p v79pos -f "$FIRST" -f "$SECOND" -f "$THIRD")
# Assert original three-layer config still means Hub auth and no API build, without
# emitting its secrets.
"${BASE[@]}" config --format json | python3 -c '
import json,sys
c=json.load(sys.stdin)
a=c["services"]["api"]
e=a.get("environment",{})
assert a.get("container_name")=="v79-pos"
assert not a.get("build")
assert e.get("AUTH_MODE")=="hub"
assert str(e.get("V79_ENTITLEMENT_RECHECK_ENABLED"))=="1"
assert e.get("NODE_ENV")=="production"
assert e.get("POS_PUBLIC_URL")=="https://pos.v79sl.com"
assert e.get("HUB_INTERNAL_URL")=="http://v79-hub:3040"
assert e.get("HUB_JWKS_URL")=="http://v79-hub:3040/.well-known/jwks.json"
assert not c["services"]["postgres"].get("ports")
assert not c["services"]["redis"].get("ports")
print("PRODUCTION_COMPOSE_GUARDS=PASS")
' || fail "effective_compose_safety"

get_counts() {
    docker exec v79-pos-db psql -X -v ON_ERROR_STOP=1 -U v79commerce -d v79commerce -Atc \
        'SELECT (SELECT count(*) FROM "Tenant"), (SELECT count(*) FROM "InventoryLedger"), (SELECT count(*) FROM "InventoryBalance");'
}
get_migration() {
    docker exec v79-pos-db psql -X -v ON_ERROR_STOP=1 -U v79commerce -d v79commerce -Atc \
        "SELECT CASE WHEN count(*)=0 THEN 'PENDING' WHEN count(*)=1 AND bool_and(finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN 'APPLIED' ELSE 'INVALID' END FROM \"_prisma_migrations\" WHERE migration_name='20261109140000_technician_stock';"
}
BEFORE_COUNTS="$(get_counts)" || fail "cannot_record_database_counts"
MIGRATION="$(get_migration)" || fail "cannot_determine_migration"
[[ "$MIGRATION" == PENDING || "$MIGRATION" == APPLIED ]] ||
    fail "migration_history_not_safe"

# Do not copy staging Compose/environment. Only reuse image bytes, under a
# distinct immutable production tag. Neither tag nor command carries secrets.
docker tag "$STAGE_TAG" "$NEW_TAG"
[[ "$(docker image inspect "$NEW_TAG" --format '{{.Id}}')" == "$STAGE_ID" ]] ||
    fail "release_image_tag_drift"

printf 'services:\n  api:\n    image: %s\n' "$NEW_TAG" > "$RELEASE_OVERLAY"
printf 'services:\n  api:\n    image: %s\n' "$OLD_TAG" > "$ROLLBACK_OVERLAY"
chmod 600 "$RELEASE_OVERLAY" "$ROLLBACK_OVERLAY"

NEW=("${BASE[@]}" -f "$RELEASE_OVERLAY")
OLD=("${BASE[@]}" -f "$ROLLBACK_OVERLAY")
"${NEW[@]}" config --format json | python3 -c '
import json,sys
c=json.load(sys.stdin)
a=c["services"]["api"]
assert a["image"]=="localhost/v79-pos:technician-stock-20261109-r1"
assert not a.get("build")
assert a.get("environment",{}).get("AUTH_MODE")=="hub"
assert str(a.get("environment",{}).get("V79_ENTITLEMENT_RECHECK_ENABLED"))=="1"
print("RELEASE_API_IMAGE_OVERRIDE=PASS")
' || fail "release_override_config_invalid"

{
    printf 'backup_sha256=%s\n' "$BACKUP_SHA"
    printf 'original_image=%s\n' "$OLD_ID"
    printf 'tested_image=%s\n' "$STAGE_ID"
    printf 'worker_container=%s\n' "$WORKER_ID"
    printf 'database_container=%s\n' "$DB_ID"
    printf 'redis_container=%s\n' "$REDIS_ID"
    printf 'hub_container=%s\n' "$HUB_ID"
    printf 'database_baseline_counts=%s\n' "$BEFORE_COUNTS"
    printf 'prior_migration_state=%s\n' "$MIGRATION"
    sha256sum "$FIRST" "$SECOND" "$THIRD"
} > "$RELEASE_DIR/checkpoint.txt"
chmod 600 "$RELEASE_DIR/checkpoint.txt"
echo "RELEASE_CHECKPOINT=PASS"
echo "OFFHOST_ENCRYPTED_BACKUP_WITNESS=RECORDED"

# The deployment uses production API service environment and network, not
# staging credentials. This is the tested additive Prisma migration.
if [[ "$MIGRATION" == PENDING ]]; then
    echo "APPLYING_ADDITIVE_TECHNICIAN_MIGRATION"
    "${NEW[@]}" run --rm --no-deps -T api ./node_modules/.bin/prisma migrate deploy ||
        fail "database_migration_failed_live_api_unchanged"
fi
[[ "$(get_migration)" == APPLIED ]] || fail "migration_not_recorded_as_applied"
[[ "$(get_counts)" == "$BEFORE_COUNTS" ]] || fail "stock_baseline_changed_by_migration"
echo "TECHNICIAN_SCHEMA_AND_STOCK_COUNTS=PASS"

rollback() {
    echo "API_HEALTH_FAILED_RESTORING_PREVIOUS_IMAGE"
    if "${OLD[@]}" up -d --no-deps --no-build --force-recreate api; then
        for attempt in {1..20}; do
            if [[ "$(docker inspect v79-pos --format '{{.State.Health.Status}}' 2>/dev/null || true)" == healthy ]]; then
                echo "POS_API_ROLLBACK=PASS"
                return 0
            fi
            sleep 3
        done
    fi
    echo "POS_API_ROLLBACK=REQUIRES_OPERATOR_ATTENTION" >&2
    return 1
}
echo "CUTTING_OVER_PRODUCTION_POS_API_ONLY"
if ! "${NEW[@]}" up -d --no-deps --no-build --force-recreate api; then
    rollback || true
    fail "production_api_recreate_failed"
fi

API_HEALTHY=0
for attempt in {1..30}; do
    if [[ "$(docker inspect v79-pos --format '{{.State.Health.Status}}' 2>/dev/null || true)" == healthy ]]; then
        API_HEALTHY=1
        break
    fi
    sleep 3
done
if [[ "$API_HEALTHY" != 1 ]] ||
   [[ "$(docker inspect v79-pos --format '{{.Image}}')" != "$STAGE_ID" ]] ||
   ! docker exec v79-pos wget -qO- http://127.0.0.1:8080/ready >/dev/null; then
    rollback || true
    fail "candidate_unhealthy_or_image_drift"
fi

# Verify no dependent production containers were replaced.
if [[ "$(docker inspect v79-pos-db --format '{{.Id}}')" != "$DB_ID" ||
      "$(docker inspect v79-pos-redis --format '{{.Id}}')" != "$REDIS_ID" ||
      "$(docker inspect v79-pos-worker --format '{{.Id}}')" != "$WORKER_ID" ||
      "$(docker inspect v79-hub --format '{{.Id}}')" != "$HUB_ID" ]]; then
    echo "PRODUCTION_DEPENDENCY_IDENTITY_DRIFT=STOP" >&2
    # Never recreate a DB, Redis, worker or Hub as an attempted auto-fix.
    exit 1
fi

if [[ "$(get_counts)" != "$BEFORE_COUNTS" ]]; then
    echo "STOCK_COUNTS_CHANGED_DURING_RELEASE=STOP_REVIEW" >&2
    exit 1
fi

echo "POS_NEW_IMAGE_ID=$STAGE_ID"
echo "TECHNICIAN_MIGRATION=PASS"
echo "EXISTING_WORKER_DB_REDIS_HUB=UNCHANGED"
echo "POS_API_PRODUCTION=DEPLOYED_HEALTHY"
echo "CUSTOMER_BROWSER_AND_DEVICE_ACCEPTANCE=PENDING"
echo "OFFHOST_ROLLBACK_EVIDENCE=$RELEASE_DIR/checkpoint.txt"

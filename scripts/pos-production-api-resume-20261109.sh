#!/usr/bin/env bash
# Resume POS production cutover after streaming SSH stdin was consumed by
# docker compose run during the successful additive Prisma migration.
# Does not run Prisma again, touch DB data, recreate worker/Hub/DB/Redis, or
# use staging environment variables. Fails closed on any identity drift.
set -Eeuo pipefail
umask 077

fail() { printf 'POS_RESUME_BLOCKED=%s\n' "$1" >&2; exit 1; }
BACKUP_SHA="${1:-}"
[[ "$BACKUP_SHA" =~ ^[[:xdigit:]]{64}$ ]] || fail "backup_digest_argument_missing"
[[ "$(hostname -s)" == "v79sl" ]] || fail "wrong_host"
WORKDIR='/home/firelion/v79-remaining-rollout.GCIN6i1p'
FIRST="$WORKDIR/v79-pos-original.pinned.yml"
SECOND='/home/firelion/vision79-pos-ui-hotfix-0b19aaa0e420/compose.ui-only.override.yaml'
THIRD='/home/firelion/v79-pos-release.hjyiubje/api-image.yml'
DIR='/home/firelion/v79-pos-technician-release-20261109'
CHECKPOINT="$DIR/checkpoint.txt"
OVERLAY="$DIR/api-release.yml"
ROLLBACK="$DIR/api-rollback.yml"
OLD_TAG='localhost/v79-brand-pos:20261106-r1'
OLD_ID='sha256:7103df9054b3433217d01f44f8495336b4ed8b55314217db9cb1167e98a186b6'
NEW_TAG='localhost/v79-pos:technician-stock-20261109-r1'
NEW_ID='sha256:9a1abea699f8f750feb21b2f53e5973389442a6be1ba945293913af973bf2433'
STAGE_TAG='v79pos:hubqa-2590623'

[[ -d "$DIR" && ! -L "$DIR" && -d "$WORKDIR" ]] || fail "release_checkpoint_directory_absent"
exec 9>"$DIR/.release.lock"
flock -n 9 || fail "release_already_in_progress"
for file in "$FIRST" "$SECOND" "$THIRD" "$CHECKPOINT" "$OVERLAY" "$ROLLBACK"; do
  [[ -f "$file" && ! -L "$file" ]] || fail "required_release_file_missing"
done
[[ "$(docker image inspect "$OLD_TAG" --format '{{.Id}}')" == "$OLD_ID" ]] ||
  fail "rollback_image_drift"
[[ "$(docker image inspect "$NEW_TAG" --format '{{.Id}}')" == "$NEW_ID" ]] ||
  fail "release_image_drift"
[[ "$(docker image inspect "$STAGE_TAG" --format '{{.Id}}')" == "$NEW_ID" ]] ||
  fail "stage_image_drift"
[[ "$(docker inspect v79-pos --format '{{.Image}}')" == "$OLD_ID" ]] ||
  fail "api_already_changed_or_drift"
[[ "$(docker inspect v79-pos --format '{{.Config.Image}}')" == "$OLD_TAG" ]] ||
  fail "api_original_tag_drift"
[[ "$(docker inspect v79-pos --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}')" == "$WORKDIR" ]] ||
  fail "compose_workdir_drift"
[[ "$(docker inspect v79-pos --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}')" == "$FIRST,$SECOND,$THIRD" ]] ||
  fail "compose_input_drift"
for c in v79-pos v79-pos-db v79-pos-redis v79-hub; do
  [[ "$(docker inspect "$c" --format '{{.State.Health.Status}}')" == "healthy" ]] ||
    fail "production_service_unhealthy"
done
[[ "$(docker inspect v79-pos-worker --format '{{.State.Running}}')" == true ]] ||
  fail "worker_not_running"

# Verify the checkpoint's recorded off-host digest, all original Docker IDs,
# initial stock counts and integrity of every original Compose file. No secrets
# or full Compose render are logged or written.
python3 - "$CHECKPOINT" "$BACKUP_SHA" "$FIRST" "$SECOND" "$THIRD" <<'PY'
import hashlib, pathlib, re, subprocess, sys
checkpoint, backup_sha, *compose_paths = sys.argv[1:]
lines = pathlib.Path(checkpoint).read_text().splitlines()
pairs = {}
for line in lines:
    if "=" in line and not re.fullmatch(r"[0-9a-f]{64}  .+", line):
        k,v=line.split("=",1)
        if k in pairs: raise SystemExit("duplicate checkpoint key")
        pairs[k]=v
assert pairs.get("backup_sha256","").lower()==backup_sha.lower(), "backup mismatch"
assert pairs.get("original_image")=="sha256:7103df9054b3433217d01f44f8495336b4ed8b55314217db9cb1167e98a186b6"
assert pairs.get("tested_image")=="sha256:9a1abea699f8f750feb21b2f53e5973389442a6be1ba945293913af973bf2433"
assert pairs.get("prior_migration_state")=="PENDING"
for key,container in [("database_container","v79-pos-db"),("redis_container","v79-pos-redis"),
                      ("worker_container","v79-pos-worker"),("hub_container","v79-hub")]:
    now=subprocess.check_output(["docker","inspect","-f","{{.Id}}",container],text=True).strip()
    assert pairs.get(key)==now, "original dependency changed: "+container
checks={}
for line in lines:
    m=re.fullmatch(r"([a-f0-9]{64})  (/.+)",line)
    if m: checks[m.group(2)]=m.group(1)
assert set(checks)==set(compose_paths),"Compose checkpoint inventory changed"
for path in compose_paths:
    assert hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()==checks[path], "Compose bytes changed"
assert re.fullmatch(r"\d+\|\d+\|\d+",pairs.get("database_baseline_counts","")), "invalid baseline counts"
print("RECORDED_BACKUP_AND_DEPENDENCIES=PASS")
print("ORIGINAL_COMPOSE_BYTES=PASS")
print("CHECKPOINT_STOCK_COUNTS="+pairs["database_baseline_counts"])
PY

# Validate stage/rollback YAML is exactly a single API image reference and
# nothing else. No opportunistic Compose rebuild.
[[ "$(cat "$OVERLAY")" == "$(printf 'services:\n  api:\n    image: %s' "$NEW_TAG")" ]] ||
  fail "release_overlay_modified"
[[ "$(cat "$ROLLBACK")" == "$(printf 'services:\n  api:\n    image: %s' "$OLD_TAG")" ]] ||
  fail "rollback_overlay_modified"

cd "$WORKDIR"
BASE=(docker compose --project-directory "$WORKDIR" -p v79pos -f "$FIRST" -f "$SECOND" -f "$THIRD")
NEW=("${BASE[@]}" -f "$OVERLAY")
OLD=("${BASE[@]}" -f "$ROLLBACK")

# Render original and upgraded configurations read-only, compare every field
# except API image. No credential-bearing output is printed or stored.
python3 - "$WORKDIR" "$FIRST" "$SECOND" "$THIRD" "$OVERLAY" <<'PY'
import copy,json,subprocess,sys
workdir,*paths=sys.argv[1:]
def render(files):
    args=["docker","compose","--project-directory",workdir,"-p","v79pos"]
    for f in files:args+=["-f",f]
    args+=["config","--format","json"]
    return json.loads(subprocess.check_output(args,cwd=workdir,stdin=subprocess.DEVNULL,text=True,stderr=subprocess.DEVNULL))
base=render(paths[:3])
new=render(paths)
assert new["services"]["api"]["image"]=="localhost/v79-pos:technician-stock-20261109-r1"
base_without=copy.deepcopy(base)
base_without["services"]["api"]["image"]=new["services"]["api"]["image"]
assert base_without==new,"release altered services beyond API image"
e=new["services"]["api"].get("environment",{})
assert e.get("NODE_ENV")=="production" and e.get("AUTH_MODE")=="hub"
assert str(e.get("V79_ENTITLEMENT_RECHECK_ENABLED"))=="1"
assert e.get("POS_PUBLIC_URL")=="https://pos.v79sl.com"
assert e.get("HUB_INTERNAL_URL")=="http://v79-hub:3040"
assert e.get("HUB_JWKS_URL")=="http://v79-hub:3040/.well-known/jwks.json"
assert not new["services"]["api"].get("build")
print("API_ONLY_PRODUCTION_CONFIG=PASS")
PY

get_counts() {
  docker exec v79-pos-db psql -X -v ON_ERROR_STOP=1 -U v79commerce -d v79commerce -Atc \
    'SELECT (SELECT count(*) FROM "Tenant"), (SELECT count(*) FROM "InventoryLedger"), (SELECT count(*) FROM "InventoryBalance");'
}
get_migration() {
  docker exec v79-pos-db psql -X -v ON_ERROR_STOP=1 -U v79commerce -d v79commerce -Atc \
    "SELECT CASE WHEN count(*)=1 AND bool_and(finished_at IS NOT NULL AND rolled_back_at IS NULL) THEN 'APPLIED' ELSE 'MISSING_OR_INVALID' END FROM \"_prisma_migrations\" WHERE migration_name='20261109140000_technician_stock';"
}
[[ "$(get_migration)" == APPLIED ]] || fail "technician_migration_not_applied"
BEFORE="$(sed -n 's/^database_baseline_counts=//p' "$CHECKPOINT")"
[[ "$(get_counts)" == "$BEFORE" ]] || fail "inventory_counts_not_matching_checkpoint"
echo "TECHNICIAN_SCHEMA_AND_STOCK_COUNTS=PASS"

rollback() {
  echo "ROLLBACK_TRIGGERED=RESTORING_PREVIOUS_POS_API"
  if "${OLD[@]}" up -d --no-deps --no-build --force-recreate api </dev/null; then
    for n in {1..25}; do
      if [[ "$(docker inspect v79-pos --format '{{.State.Health.Status}}' 2>/dev/null || true)" == healthy &&
            "$(docker inspect v79-pos --format '{{.Image}}' 2>/dev/null || true)" == "$OLD_ID" ]]; then
        echo "POS_API_IMAGE_ROLLBACK=PASS"
        return 0
      fi
      sleep 3
    done
  fi
  echo "POS_API_IMAGE_ROLLBACK=FAILED_NEEDS_MANUAL_INTERVENTION" >&2
  return 1
}

echo "PRODUCTION_API_ONLY_CUTOVER=STARTING"
if ! "${NEW[@]}" up -d --no-deps --no-build --force-recreate api </dev/null; then
  rollback || true
  fail "api_recreate_failed"
fi
HEALTH_OK=0
for n in {1..30}; do
  if [[ "$(docker inspect v79-pos --format '{{.State.Health.Status}}' 2>/dev/null || true)" == healthy ]]; then
    HEALTH_OK=1
    break
  fi
  sleep 3
done
if [[ "$HEALTH_OK" != 1 ||
      "$(docker inspect v79-pos --format '{{.Image}}' 2>/dev/null || true)" != "$NEW_ID" ]] ||
   ! docker exec v79-pos wget -qO- http://127.0.0.1:8080/ready >/dev/null 2>&1; then
  rollback || true
  fail "new_api_unhealthy_or_image_mismatch"
fi
[[ "$(get_counts)" == "$BEFORE" ]] || fail "inventory_counts_changed_after_cutover"
[[ "$(get_migration)" == APPLIED ]] || fail "migration_status_changed"
echo "POS_NEW_IMAGE_ID=$NEW_ID"
echo "EXISTING_WORKER_DB_REDIS_HUB=UNCHANGED"
echo "POS_API_PRODUCTION=DEPLOYED_HEALTHY"
echo "CUSTOMER_HTTPS_MFA_AND_DEVICE_ACCEPTANCE=PENDING"

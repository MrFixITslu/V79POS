#!/usr/bin/env bash
# Controlled V79 POS API-only Docker container promotion, without Docker Compose.
# No DB migration. No Hub/DB/Redis/worker replacement. Preserve original API.
# Execute on v79sl; first arg is independently verified off-host backup SHA256.
set -Eeuo pipefail
umask 077

fail() { echo "POS_DIRECT_CUTOVER_BLOCKED=$1" >&2; exit 1; }
SHA="${1:-}"
[[ "$SHA" =~ ^[[:xdigit:]]{64}$ ]] || fail "backup_sha_missing"
[[ "$(hostname -s)" == v79sl ]] || fail "unexpected_host"

LIVE='v79-pos'
CANDIDATE='v79-pos-technician-candidate-20261110'
PARKED='v79-pos-pretech-20261110'
FAILED='v79-pos-failed-20261110'
OLD_TAG='localhost/v79-brand-pos:20261106-r1'
OLD_ID='sha256:7103df9054b3433217d01f44f8495336b4ed8b55314217db9cb1167e98a186b6'
STAGE_TAG='v79pos:hubqa-2590623'
NEW_TAG='localhost/v79-pos:technician-stock-20261110-r1'
NEW_ID='sha256:9a1abea699f8f750feb21b2f53e5973389442a6be1ba945293913af973bf2433'
INTERNAL='v79pos_pos_internal'
PROXY='proxy_network'
RELEASE='/home/firelion/v79-pos-technician-release-20261109'
CHECKPOINT="$RELEASE/checkpoint.txt"

[[ -f "$CHECKPOINT" && ! -L "$CHECKPOINT" ]] || fail "existing_release_checkpoint_missing"
exec 9>"$RELEASE/.release.lock"
flock -n 9 || fail "release_lock_busy"

# Prior failed Compose-based cutover was rolled back. Do not interfere with any
# possible concurrent release or reuse names from an earlier attempt.
for name in "$CANDIDATE" "$PARKED" "$FAILED"; do
  ! docker container inspect "$name" >/dev/null 2>&1 ||
    fail "named_container_already_exists_$name"
done
[[ "$(docker image inspect "$OLD_TAG" --format '{{.Id}}')" == "$OLD_ID" ]] ||
  fail "rollback_image_identity"
[[ "$(docker image inspect "$STAGE_TAG" --format '{{.Id}}')" == "$NEW_ID" ]] ||
  fail "tested_stage_image_identity"
if docker image inspect "$NEW_TAG" >/dev/null 2>&1; then
  [[ "$(docker image inspect "$NEW_TAG" --format '{{.Id}}')" == "$NEW_ID" ]] ||
    fail "preexisting_production_release_tag_drift"
else
  docker tag "$STAGE_TAG" "$NEW_TAG"
fi
[[ "$(docker image inspect "$NEW_TAG" --format '{{.Id}}')" == "$NEW_ID" ]] ||
  fail "production_release_image_identity"
[[ "$(docker inspect "$LIVE" --format '{{.Image}}')" == "$OLD_ID" ]] ||
  fail "production_image_identity"
[[ "$(docker inspect "$LIVE" --format '{{.Config.Image}}')" == "$OLD_TAG" ]] ||
  fail "production_image_tag"
for name in "$LIVE" v79-pos-db v79-pos-redis v79-hub; do
  [[ "$(docker inspect "$name" --format '{{.State.Health.Status}}')" == healthy ]] ||
    fail "unhealthy_$name"
done
[[ "$(docker inspect v79-pos-worker --format '{{.State.Running}}')" == true ]] ||
  fail "production_worker_not_running"

# Do not print credentials. Require exact known origin, network aliases and
# production container security configuration, including checked backup witness.
python3 - "$CHECKPOINT" "$SHA" <<'PY'
import json,subprocess,sys
checkpoint,sha=sys.argv[1:]
data={}
for line in open(checkpoint):
    if "=" in line:
        key,val=line.strip().split("=",1)
        if key in data: raise SystemExit("duplicate checkpoint key")
        data[key]=val
assert data.get("backup_sha256","").lower()==sha.lower(), "backup witness differs"
assert data.get("prior_migration_state")=="PENDING"
def get(name):
    return json.loads(subprocess.check_output(["docker","inspect",name],text=True))[0]
c=get("v79-pos"); h=c["HostConfig"]
for key,name in (("database_container","v79-pos-db"),("redis_container","v79-pos-redis"),
                 ("worker_container","v79-pos-worker"),("hub_container","v79-hub")):
    assert data.get(key)==get(name)["Id"], "production dependency drift: "+name
assert c["Config"]["Image"]=="localhost/v79-brand-pos:20261106-r1"
assert c["Config"]["Entrypoint"]==["/app/scripts/docker-entrypoint.sh"]
assert c["Config"]["Cmd"]==["node","apps/api/dist/server.js"]
assert c["Config"]["User"]=="node"
assert c["Config"]["WorkingDir"]=="/app"
assert c["Config"]["Healthcheck"]["Test"]==["CMD","wget","-qO-","http://127.0.0.1:8080/ready"]
assert h["RestartPolicy"]["Name"]=="unless-stopped"
assert h.get("Privileged")==False and h.get("ReadonlyRootfs")==False
assert h.get("Init")==True
assert "no-new-privileges:true" in (h.get("SecurityOpt") or [])
assert not h.get("PortBindings") and not c["Mounts"]
assert not h.get("ExtraHosts") and h.get("Memory")==0 and h.get("NanoCpus")==0
nets=c["NetworkSettings"]["Networks"]
assert set(nets)=={"v79pos_pos_internal","proxy_network"}
assert {"v79-pos","api"}.issubset(set(nets["v79pos_pos_internal"].get("Aliases") or []))
assert {"v79-pos","api","v79-commerce-api"}.issubset(set(nets["proxy_network"].get("Aliases") or []))
env=dict(part.split("=",1) for part in c["Config"]["Env"])
for key,val in (("NODE_ENV","production"),("AUTH_MODE","hub"),
                ("V79_ENTITLEMENT_RECHECK_ENABLED","1"),
                ("POS_PUBLIC_URL","https://pos.v79sl.com"),
                ("HUB_INTERNAL_URL","http://v79-hub:3040"),
                ("HUB_JWKS_URL","http://v79-hub:3040/.well-known/jwks.json")):
    assert env.get(key)==val,"critical production setting mismatch: "+key
assert len(env.get("V79_POS_PLATFORM_SHARED_SECRET") or env.get("V79_PLATFORM_SHARED_SECRET") or "")>=32
print("CHECKPOINT_RUNTIME_SECURITY_AND_NETWORK=PASS")
PY

get_counts() {
  docker exec v79-pos-db psql -X -v ON_ERROR_STOP=1 -U v79commerce -d v79commerce -Atc \
    'SELECT (SELECT count(*) FROM "Tenant"), (SELECT count(*) FROM "InventoryLedger"), (SELECT count(*) FROM "InventoryBalance");'
}
get_migration() {
  docker exec v79-pos-db psql -X -v ON_ERROR_STOP=1 -U v79commerce -d v79commerce -Atc \
    "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='20261109140000_technician_stock' AND finished_at IS NOT NULL AND rolled_back_at IS NULL;"
}
[[ "$(get_migration)" == 1 ]] || fail "production_migration_not_applied"
ORIGINAL_COUNTS="$(sed -n 's/^database_baseline_counts=//p' "$CHECKPOINT")"
[[ "$(get_counts)" == "$ORIGINAL_COUNTS" ]] || fail "stock_baseline_drift"
echo "PREEXISTING_MIGRATION_AND_STOCK_COUNTS=PASS"

ORIGINAL_DB_ID="$(docker inspect v79-pos-db --format '{{.Id}}')"
ORIGINAL_REDIS_ID="$(docker inspect v79-pos-redis --format '{{.Id}}')"
ORIGINAL_WORKER_ID="$(docker inspect v79-pos-worker --format '{{.Id}}')"
ORIGINAL_HUB_ID="$(docker inspect v79-hub --format '{{.Id}}')"

# Compare public readiness against the same server's baseline. If inaccessible
# before the release, do not use local hairpin TLS as a false-negative.
PUBLIC_BASELINE=0
if curl --fail --silent --show-error --max-time 10 \
  https://pos.v79sl.com/ready >/dev/null 2>&1; then
  PUBLIC_BASELINE=1
fi
echo "PUBLIC_TLS_READINESS_BASELINE=$PUBLIC_BASELINE"

ROLLOUT_STARTED=0
COMMITTED=0
on_exit() {
  code=$?
  trap - EXIT
  if [[ "$COMMITTED" == 1 ]]; then exit "$code"; fi
  if [[ "$ROLLOUT_STARTED" == 1 ]]; then
    echo "CUTOVER_ROLLBACK=STARTING" >&2
    if docker container inspect "$LIVE" >/dev/null 2>&1; then
      active="$(docker inspect "$LIVE" --format '{{.Image}}' 2>/dev/null || true)"
      if [[ "$active" == "$NEW_ID" ]]; then
        docker update --restart no "$LIVE" >/dev/null 2>&1 || true
        docker stop -t 10 "$LIVE" >/dev/null 2>&1 || true
        docker rename "$LIVE" "$FAILED" >/dev/null 2>&1 || true
      fi
    fi
    if docker container inspect "$PARKED" >/dev/null 2>&1; then
      if ! docker container inspect "$LIVE" >/dev/null 2>&1; then
        docker rename "$PARKED" "$LIVE" >/dev/null 2>&1 || true
      fi
    fi
    if [[ "$(docker inspect "$LIVE" --format '{{.Image}}' 2>/dev/null || true)" == "$OLD_ID" ]]; then
      docker start "$LIVE" >/dev/null 2>&1 || true
      for i in {1..25}; do
        if [[ "$(docker inspect "$LIVE" --format '{{.State.Health.Status}}' 2>/dev/null || true)" == healthy ]]; then
          echo "POS_OLD_IMAGE_RESTORED=PASS" >&2
          break
        fi
        sleep 2
      done
    fi
    if [[ "$(docker inspect "$LIVE" --format '{{.State.Health.Status}}' 2>/dev/null || true)" != healthy ]]; then
      echo "ROLLBACK_REQUIRES_MANUAL_INTERVENTION=YES" >&2
    fi
  else
    docker rm -f "$CANDIDATE" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap on_exit EXIT

# Safely pass existing container environment through a Linux memory file
# descriptor. No .env files written, credentials not displayed in logs/argv.
python3 - "$NEW_TAG" "$CANDIDATE" "$INTERNAL" <<'PY'
import json,os,subprocess,sys
image,name,network=sys.argv[1:]
c=json.loads(subprocess.check_output(["docker","inspect","v79-pos"],text=True))[0]
entries=c["Config"]["Env"]
assert all("\n" not in item and "\r" not in item for item in entries)
fd=os.memfd_create("v79-pos-production-env",0)
os.write(fd,("\n".join(entries)+"\n").encode())
os.lseek(fd,0,os.SEEK_SET)
cmd=["docker","run","-d","--pull","never","--name",name,
     "--network",network,"--restart","no",
     "--init","--security-opt","no-new-privileges:true",
     "--health-cmd","wget -qO- http://127.0.0.1:8080/ready",
     "--health-interval","15s","--health-timeout","5s",
     "--health-retries","10","--health-start-period","20s",
     "--env-file",f"/proc/self/fd/{fd}",image]
r=subprocess.run(cmd,pass_fds=(fd,),stdin=subprocess.DEVNULL,
                 stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
os.close(fd)
if r.returncode: raise SystemExit("candidate Docker start failed: "+r.stderr[-700:])
print("NEW_CANDIDATE_CREATED=PASS")
PY
docker network connect "$PROXY" "$CANDIDATE" </dev/null

wait_healthy() {
  name="$1"
  for i in {1..30}; do
    if [[ "$(docker inspect "$name" --format '{{.State.Health.Status}}' 2>/dev/null || true)" == healthy ]]; then
      return 0
    fi
    [[ "$(docker inspect "$name" --format '{{.State.Running}}' 2>/dev/null || true)" == true ]] || return 1
    sleep 3
  done
  return 1
}
wait_healthy "$CANDIDATE" || fail "candidate_unhealthy_under_live_environment"
for path in ready reports-ui.js technician technician.js favicon.svg; do
  docker exec "$CANDIDATE" wget -qO- "http://127.0.0.1:8080/$path" \
    >/dev/null 2>&1 || fail "candidate_route_$path"
done
docker exec "$CANDIDATE" wget -qO- \
  'http://v79-hub:3040/.well-known/jwks.json' >/dev/null 2>&1 ||
  fail "hub_internal_jwks_not_reachable"
echo "CANDIDATE_LIVE_ENV_DB_HUB_FEATURES=PASS"

# We now have a healthy live-config candidate. Change only the API names and
# Docker DNS aliases; no compose up, migration, DB/Redis/Hub/worker restart.
ROLLOUT_STARTED=1
echo "API_ONLY_PROMOTION=STARTING"
docker stop -t 20 "$LIVE" </dev/null >/dev/null
docker rename "$LIVE" "$PARKED" </dev/null
docker rename "$CANDIDATE" "$LIVE" </dev/null
# The candidate was connected without production aliases during canary checks.
# Refresh each attachment to gain the original v79-pos/api/service DNS names.
docker network disconnect "$PROXY" "$LIVE" </dev/null
docker network connect --alias v79-pos --alias api --alias v79-commerce-api \
  "$PROXY" "$LIVE" </dev/null
docker network disconnect "$INTERNAL" "$LIVE" </dev/null
docker network connect --alias v79-pos --alias api "$INTERNAL" "$LIVE" </dev/null
docker update --restart unless-stopped "$LIVE" </dev/null >/dev/null

wait_healthy "$LIVE" || fail "promoted_api_health"
[[ "$(docker inspect "$LIVE" --format '{{.Image}}')" == "$NEW_ID" ]] ||
  fail "promoted_image_drift"
for path in ready reports-ui.js technician technician.js favicon.svg; do
  docker exec "$LIVE" wget -qO- "http://127.0.0.1:8080/$path" \
    >/dev/null 2>&1 || fail "promoted_route_$path"
done
python3 - <<'PY'
import json,subprocess
c=json.loads(subprocess.check_output(["docker","inspect","v79-pos"],text=True))[0]
n=c["NetworkSettings"]["Networks"]
assert set(n)=={"proxy_network","v79pos_pos_internal"}
assert {"v79-pos","api","v79-commerce-api"}.issubset(n["proxy_network"]["Aliases"])
assert {"v79-pos","api"}.issubset(n["v79pos_pos_internal"]["Aliases"])
assert c["HostConfig"]["RestartPolicy"]["Name"]=="unless-stopped"
assert c["HostConfig"]["Init"]==True
assert "no-new-privileges:true" in c["HostConfig"]["SecurityOpt"]
print("PROXY_ALIASES_AND_SECURITY_RETAINED=PASS")
PY

for name_id in \
  "v79-pos-db:$ORIGINAL_DB_ID" \
  "v79-pos-redis:$ORIGINAL_REDIS_ID" \
  "v79-pos-worker:$ORIGINAL_WORKER_ID" \
  "v79-hub:$ORIGINAL_HUB_ID"; do
  name="${name_id%%:*}"
  id="${name_id#*:}"
  [[ "$(docker inspect "$name" --format '{{.Id}}')" == "$id" ]] ||
    fail "unrelated_service_replaced_$name"
done
[[ "$(get_counts)" == "$ORIGINAL_COUNTS" ]] || fail "inventory_counts_changed"
[[ "$(get_migration)" == 1 ]] || fail "technician_migration_changed"

if [[ "$PUBLIC_BASELINE" == 1 ]]; then
  curl --fail --silent --show-error --max-time 15 \
    https://pos.v79sl.com/ready >/dev/null || fail "public_tls_readiness_failed"
  echo "PUBLIC_TLS_READY=PASS"
else
  echo "PUBLIC_TLS_READY=NOT_CHECKED_BASELINE_UNAVAILABLE"
fi
COMMITTED=1
echo "POS_API_PRODUCTION=DEPLOYED_HEALTHY"
echo "REPORTS_AND_TECHNICIAN_ASSETS=PASS"
echo "UNRELATED_SERVICES=UNCHANGED"
echo "ORIGINAL_POS_CONTAINER_RETAINED=$PARKED"
echo "CUSTOMER_HUB_MFA_AND_ROLE_BROWSER_ACCEPTANCE=PENDING"
echo "DO_NOT_USE_PREVIOUS_COMPOSE_UP_UNTIL_STACK_RECONCILED=YES"

#!/usr/bin/env bash
# Apply the reviewed POS Team refresh / Technician Inventory UI hotfix.
# Direct Docker API-only release, never Compose. No database writes/migrations.
# Args: exact git commit SHA; verified off-host archive SHA-256
set -Eeuo pipefail
umask 077
fail() { echo "POS_TEAM_UI_RELEASE_BLOCKED=$1" >&2; exit 1; }

REV="${1:-}"
BACKUP_SHA="${2:-}"
[[ "$REV" =~ ^[0-9a-f]{40}$ ]] || fail "source_commit_required"
[[ "$BACKUP_SHA" == "bc793e3ddb19f73011baf539750f3ed1e6a2d12809aa181cb2bd420121e9cd75" ]] ||
    fail "unexpected_offhost_backup_witness"
[[ "$(hostname -s)" == v79sl ]] || fail "wrong_host"

SRC='/home/firelion/v79-pos-hubqa-20261109/source'
LOCK_DIR='/home/firelion/v79-pos-technician-release-20261109'
BASE_TAG='localhost/v79-pos:technician-stock-20261110-r1'
BASE_ID='sha256:9a1abea699f8f750feb21b2f53e5973389442a6be1ba945293913af973bf2433'
FIX_TAG='localhost/v79-pos:team-technician-ui-20261110-r2'
LIVE='v79-pos'
CANDIDATE='v79-pos-teamui-canary-20261110'
PARKED='v79-pos-preteamui-20261110'
FAILED='v79-pos-teamui-failed-20261110'
INTERNAL='v79pos_pos_internal'
PROXY='proxy_network'

[[ -d "$SRC" && -d "$LOCK_DIR" ]] || fail "release_workspace_missing"
exec 9>"$LOCK_DIR/.release.lock"
flock -n 9 || fail "another_pos_release_is_running"
for c in "$CANDIDATE" "$PARKED" "$FAILED"; do
  ! docker container inspect "$c" >/dev/null 2>&1 ||
    fail "container_name_in_use_$c"
done
[[ "$(docker image inspect "$BASE_TAG" --format '{{.Id}}')" == "$BASE_ID" ]] ||
    fail "base_image_identity_mismatch"
[[ "$(docker inspect "$LIVE" --format '{{.Image}}')" == "$BASE_ID" ]] ||
    fail "current_live_pos_image_mismatch"
[[ "$(docker inspect "$LIVE" --format '{{.Config.Image}}')" == "$BASE_TAG" ]] ||
    fail "current_live_pos_tag_mismatch"
for service in "$LIVE" v79-pos-db v79-pos-redis v79-hub; do
  [[ "$(docker inspect "$service" --format '{{.State.Health.Status}}')" == healthy ]] ||
    fail "production_unhealthy_$service"
done
[[ "$(docker inspect v79-pos-worker --format '{{.State.Running}}')" == true ]] ||
  fail "worker_not_running"
[[ "$(git -C "$SRC" cat-file -t "$REV")" == commit ]] ||
  fail "release_git_commit_missing"

# Only the POS shell JavaScript may differ from the tested candidate:
# preserve its backend, security, database, CSS, manifest and all branded assets.
CHANGED="$(git -C "$SRC" diff --name-only \
  25906235cb59e6fe89f41fbfc2f298a55ca9da45 "$REV" -- apps/api/public/ apps/api/src/ prisma/)"
[[ "$CHANGED" == "apps/api/public/app.js" ]] || fail "application_changes_beyond_approved_ui_file"
echo "TESTED_BASE_AND_SINGLE_FILE_CHANGE=PASS"

# Verify the currently running container matches its expected security,
# environment and unique DNS aliases. Never print secrets.
python3 <<'PY'
import json, subprocess
def inspect(name):
    return json.loads(subprocess.check_output(["docker","inspect",name],text=True))[0]
c=inspect("v79-pos")
h=c["HostConfig"]
assert c["Config"]["User"]=="node"
assert c["Config"]["Entrypoint"]==["/app/scripts/docker-entrypoint.sh"]
assert c["Config"]["Cmd"]==["node","apps/api/dist/server.js"]
assert c["Config"]["Healthcheck"]["Test"]==["CMD","wget","-qO-","http://127.0.0.1:8080/ready"]
assert h["RestartPolicy"]["Name"]=="unless-stopped"
assert h["Init"] is True and h["Privileged"] is False
assert "no-new-privileges:true" in (h["SecurityOpt"] or [])
assert not h["PortBindings"] and not c["Mounts"]
nets=c["NetworkSettings"]["Networks"]
assert set(nets)=={"proxy_network","v79pos_pos_internal"}
assert {"v79-pos","api","v79-commerce-api"}.issubset(nets["proxy_network"]["Aliases"])
assert {"v79-pos","api"}.issubset(nets["v79pos_pos_internal"]["Aliases"])
env=dict(s.split("=",1) for s in c["Config"]["Env"])
for k,v in {"NODE_ENV":"production","AUTH_MODE":"hub",
            "V79_ENTITLEMENT_RECHECK_ENABLED":"1",
            "POS_PUBLIC_URL":"https://pos.v79sl.com"}.items():
    assert env.get(k)==v
print("LIVE_SECURITY_AND_HUB_AUTH=PASS")
PY

DB_ID="$(docker inspect v79-pos-db --format '{{.Id}}')"
REDIS_ID="$(docker inspect v79-pos-redis --format '{{.Id}}')"
WORKER_ID="$(docker inspect v79-pos-worker --format '{{.Id}}')"
HUB_ID="$(docker inspect v79-hub --format '{{.Id}}')"

counts() {
  docker exec v79-pos-db psql -X -v ON_ERROR_STOP=1 -U v79commerce -d v79commerce -Atc \
   'SELECT (SELECT count(*) FROM "Tenant"), (SELECT count(*) FROM "InventoryLedger"), (SELECT count(*) FROM "InventoryBalance");'
}
MIGRATION="$(docker exec v79-pos-db psql -X -v ON_ERROR_STOP=1 -U v79commerce -d v79commerce -Atc \
 "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name='20261109140000_technician_stock' AND finished_at IS NOT NULL AND rolled_back_at IS NULL;")"
[[ "$MIGRATION" == 1 ]] || fail "live_technician_schema_missing"
PRE_COUNTS="$(counts)" || fail "cannot_read_live_stock_baseline"

WORK="$(mktemp -d /tmp/v79-pos-teamui.XXXXXX)"
PROMOTION_STARTED=0
DEPLOYED=0
rollback() {
  code=$?
  trap - EXIT
  rm -rf -- "$WORK"
  if [[ "$DEPLOYED" == 1 ]]; then exit "$code"; fi
  if [[ "$PROMOTION_STARTED" == 1 ]]; then
    echo "POS_TEAM_UI_ROLLBACK=STARTING" >&2
    running_id="$(docker inspect "$LIVE" --format '{{.Image}}' 2>/dev/null || true)"
    if [[ -n "$running_id" && "$running_id" != "$BASE_ID" ]]; then
      docker update --restart no "$LIVE" >/dev/null 2>&1 || true
      docker stop -t 15 "$LIVE" >/dev/null 2>&1 || true
      docker rename "$LIVE" "$FAILED" >/dev/null 2>&1 || true
    fi
    if docker container inspect "$PARKED" >/dev/null 2>&1; then
      if ! docker container inspect "$LIVE" >/dev/null 2>&1; then
        docker rename "$PARKED" "$LIVE" >/dev/null 2>&1 || true
      fi
    fi
    if [[ "$(docker inspect "$LIVE" --format '{{.Image}}' 2>/dev/null || true)" == "$BASE_ID" ]]; then
      docker start "$LIVE" >/dev/null 2>&1 || true
      for i in {1..20}; do
        if [[ "$(docker inspect "$LIVE" --format '{{.State.Health.Status}}' 2>/dev/null || true)" == healthy ]]; then
          echo "POS_PREVIOUS_API_RESTORED=PASS" >&2
          break
        fi
        sleep 3
      done
    fi
    [[ "$(docker inspect "$LIVE" --format '{{.State.Health.Status}}' 2>/dev/null || true)" == healthy ]] ||
      echo "POS_ROLLBACK=MANUAL_ATTENTION_REQUIRED" >&2
  else
    docker rm -f "$CANDIDATE" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap rollback EXIT

# Build an offline image using the exact currently deployed image as the
# only parent and the single, reviewed app.js from this Git SHA.
git -C "$SRC" show "$REV:apps/api/public/app.js" > "$WORK/app.js"
docker run --rm -i --pull never --network none --entrypoint node \
 "$BASE_TAG" --input-type=module --check - < "$WORK/app.js" || fail "ui_javascript_syntax_invalid"
grep -q 'Technician Inventory' "$WORK/app.js" || fail "technician_navigation_missing"
grep -q 'Team response is invalid' "$WORK/app.js" || fail "team_contract_fix_missing"
cat > "$WORK/Dockerfile" <<'EOF'
FROM localhost/v79-pos:technician-stock-20261110-r1
COPY --chown=node:node app.js /app/apps/api/public/app.js
EOF
if docker image inspect "$FIX_TAG" >/dev/null 2>&1; then
  fail "proposed_fix_tag_already_exists"
fi
docker build --pull=false --network=none \
  -t "$FIX_TAG" "$WORK" </dev/null >/dev/null
FIX_ID="$(docker image inspect "$FIX_TAG" --format '{{.Id}}')"
[[ "$FIX_ID" != "$BASE_ID" ]] || fail "build_did_not_change_ui"
SOURCE_SHA="$(sha256sum "$WORK/app.js" | cut -d' ' -f1)"
IMAGE_SHA="$(docker run --rm --pull never --network none --entrypoint sha256sum \
 "$FIX_TAG" /app/apps/api/public/app.js </dev/null | cut -d' ' -f1)"
[[ "$IMAGE_SHA" == "$SOURCE_SHA" ]] || fail "built_image_ui_hash_mismatch"
echo "SINGLE_FILE_UI_IMAGE_BUILT=PASS"

# Reuse exactly the current POS container's production env, but pass its values
# exclusively over a private anonymous memory file descriptor.
python3 - "$FIX_TAG" "$CANDIDATE" "$INTERNAL" <<'PY'
import json,os,subprocess,sys
image,name,network=sys.argv[1:]
c=json.loads(subprocess.check_output(["docker","inspect","v79-pos"],text=True))[0]
entries=c["Config"]["Env"]
assert all("\n" not in x and "\r" not in x for x in entries)
fd=os.memfd_create("v79-pos-teamui-env",0)
os.write(fd,("\n".join(entries)+"\n").encode())
os.lseek(fd,0,os.SEEK_SET)
cmd=["docker","run","-d","--pull","never","--restart","no",
     "--name",name,"--network",network,"--init",
     "--security-opt","no-new-privileges:true",
     "--health-cmd","wget -qO- http://127.0.0.1:8080/ready",
     "--health-interval","15s","--health-timeout","5s",
     "--health-retries","10","--health-start-period","20s",
     "--env-file",f"/proc/self/fd/{fd}",image]
p=subprocess.run(cmd,pass_fds=(fd,),stdin=subprocess.DEVNULL,
                 stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
os.close(fd)
assert p.returncode == 0, "candidate Docker creation failed"
print("PRODUCTION_ENV_CANARY_STARTED=PASS")
PY
docker network connect "$PROXY" "$CANDIDATE" </dev/null

wait_ready() {
  for i in {1..30}; do
    [[ "$(docker inspect "$1" --format '{{.State.Running}}' 2>/dev/null || true)" == true ]] ||
      return 1
    if [[ "$(docker inspect "$1" --format '{{.State.Health.Status}}' 2>/dev/null || true)" == healthy ]]; then
      return 0
    fi
    sleep 3
  done
  return 1
}
wait_ready "$CANDIDATE" || fail "production_env_canary_not_healthy"
for path in ready app.js technician reports-ui.js favicon.svg; do
  docker exec "$CANDIDATE" wget -qO- "http://127.0.0.1:8080/$path" \
    >/dev/null 2>&1 || fail "canary_asset_$path"
done
docker exec "$CANDIDATE" wget -qO- \
 'http://v79-hub:3040/.well-known/jwks.json' >/dev/null 2>&1 ||
 fail "canary_hub_jwks_unreachable"
docker exec "$CANDIDATE" node -e \
 "const s=require('fs').readFileSync('/app/apps/api/public/app.js','utf8'); if(!s.includes('Technician Inventory')||!s.includes('Team response is invalid'))process.exit(2);" \
 </dev/null || fail "canary_ui_incomplete"
echo "CANARY_TEAM_AND_TECHNICIAN_UI=PASS"

# Atomic operational handoff: no Compose changes, no DB/worker/Hub restarts.
PROMOTION_STARTED=1
echo "POS_TEAM_UI_API_ONLY_PROMOTION=STARTING"
docker stop -t 20 "$LIVE" </dev/null >/dev/null
docker rename "$LIVE" "$PARKED" </dev/null
docker rename "$CANDIDATE" "$LIVE" </dev/null
docker network disconnect "$PROXY" "$LIVE" </dev/null
docker network connect --alias v79-pos --alias api --alias v79-commerce-api \
 "$PROXY" "$LIVE" </dev/null
docker network disconnect "$INTERNAL" "$LIVE" </dev/null
docker network connect --alias v79-pos --alias api "$INTERNAL" "$LIVE" </dev/null
docker update --restart unless-stopped "$LIVE" </dev/null >/dev/null

wait_ready "$LIVE" || fail "promoted_api_not_healthy"
[[ "$(docker inspect "$LIVE" --format '{{.Image}}')" == "$FIX_ID" ]] ||
  fail "new_api_image_identity_mismatch"
for path in ready app.js technician reports-ui.js favicon.svg; do
  docker exec "$LIVE" wget -qO- "http://127.0.0.1:8080/$path" \
    >/dev/null 2>&1 || fail "live_asset_$path"
done
python3 <<'PY'
import json,subprocess
c=json.loads(subprocess.check_output(["docker","inspect","v79-pos"],text=True))[0]
nets=c["NetworkSettings"]["Networks"]
assert set(nets)=={"proxy_network","v79pos_pos_internal"}
assert {"v79-pos","api","v79-commerce-api"}.issubset(nets["proxy_network"]["Aliases"])
assert {"v79-pos","api"}.issubset(nets["v79pos_pos_internal"]["Aliases"])
assert c["HostConfig"]["RestartPolicy"]["Name"]=="unless-stopped"
assert c["HostConfig"]["Init"] is True
assert "no-new-privileges:true" in c["HostConfig"]["SecurityOpt"]
print("NETWORK_ALIASES_SECURITY=PASS")
PY
for item in \
 "v79-pos-db:$DB_ID" "v79-pos-redis:$REDIS_ID" \
 "v79-pos-worker:$WORKER_ID" "v79-hub:$HUB_ID"; do
  name="${item%%:*}"
  expected="${item#*:}"
  [[ "$(docker inspect "$name" --format '{{.Id}}')" == "$expected" ]] ||
    fail "unrelated_production_container_changed_$name"
done
[[ "$(counts)" == "$PRE_COUNTS" ]] || fail "live_inventory_counts_changed_during_ui_promotion"
curl --fail --silent --show-error --max-time 15 \
 https://pos.v79sl.com/ready >/dev/null || fail "public_tls_health_failure"
DEPLOYED=1
echo "POS_TEAM_REFRESH_UI_FIX=DEPLOYED_HEALTHY"
echo "TECHNICIAN_INVENTORY_OWNER_NAV=DEPLOYED"
echo "POS_BACKEND_SCHEMA_AND_BRANDING=UNCHANGED"
echo "PREVIOUS_POS_API_CONTAINER_RETAINED=$PARKED"
echo "CUSTOMER_BROWSER_TEAM_API_AND_TECHNICIAN_NAV=REQUIRES_ACCEPTANCE"
echo "DO_NOT_RUN_LEGACY_POS_COMPOSE_UP=YES"

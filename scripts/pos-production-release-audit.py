#!/usr/bin/env python3
"""Read-only POS release evidence. Never edits Docker, Compose or a database."""
import json
from pathlib import Path
import subprocess
import sys

PROD_TAG = "localhost/v79-brand-pos:20261106-r1"
PROD_ID = "sha256:7103df9054b3433217d01f44f8495336b4ed8b55314217db9cb1167e98a186b6"
STAGE_TAG = "v79pos:hubqa-2590623"
STAGE_ID = "sha256:9a1abea699f8f750feb21b2f53e5973389442a6be1ba945293913af973bf2433"
STAGE_SHA = "25906235cb59e6fe89f41fbfc2f298a55ca9da45"
STAGE_NET = "v79pos-hubqa-20261109_stage_internal"
SOURCE = Path("/home/firelion/v79-pos-hubqa-20261109/source")

def call(*cmd):
    result = subprocess.run(cmd, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError("Unable to inspect " + cmd[0] + " safely")
    return result.stdout.strip()

def inspect(name, kind="container"):
    return json.loads(call("docker", kind, "inspect", name))[0]

def require(ok, label):
    if not ok:
        raise RuntimeError("BLOCKED_" + label)
    print(label + "=PASS", flush=True)

def named_volumes(container):
    return {m.get("Name") or m.get("Source") for m in container.get("Mounts", [])
            if m.get("Type") == "volume"}

def main():
    require(SOURCE.is_dir() and not SOURCE.is_symlink(),
            "PINNED_STAGE_CHECKOUT_PRESENT")
    require(call("git", "-C", str(SOURCE), "rev-parse", "HEAD") == STAGE_SHA,
            "PINNED_CANDIDATE_SOURCE")
    require(not call("git", "-C", str(SOURCE), "diff", "--name-only") and
            not call("git", "-C", str(SOURCE), "diff", "--cached", "--name-only"),
            "PINNED_CANDIDATE_TREE_CLEAN")
    prod = inspect("v79-pos")
    prod_db = inspect("v79-pos-db")
    prod_redis = inspect("v79-pos-redis")
    stage = inspect("v79-pos-hubqa-api")
    stage_db = inspect("v79-pos-hubqa-db")
    stage_redis = inspect("v79-pos-hubqa-redis")
    hub = inspect("v79-hub")
    stage_hub = inspect("v79-hub-pos-hubqa")

    checks = (
        ("v79-pos", prod), ("v79-pos-db", prod_db),
        ("v79-pos-redis", prod_redis), ("v79-pos-hubqa-api", stage),
        ("v79-pos-hubqa-db", stage_db),
        ("v79-pos-hubqa-redis", stage_redis),
        ("v79-hub", hub), ("v79-hub-pos-hubqa", stage_hub)
    )
    all_healthy = True
    for name, container in checks:
        state = container["State"]
        status = state.get("Health", {}).get("Status", "not-configured")
        running = state.get("Running") is True
        print("CONTAINER_STATUS=" + name +
              " RUNNING=" + ("yes" if running else "no") +
              " HEALTH=" + status +
              " RESTARTS=" + str(container.get("RestartCount", 0)),
              flush=True)
        if not running or status != "healthy":
            all_healthy = False
    require(all_healthy, "EXISTING_EIGHT_CONTAINERS_HEALTHY")
    require(prod["Config"]["Image"] == PROD_TAG and prod["Image"] == PROD_ID
            and inspect(PROD_TAG, "image")["Id"] == PROD_ID,
            "LIVE_ROLLBACK_IMAGE_PINNED")
    require(stage["Config"]["Image"] == STAGE_TAG and stage["Image"] == STAGE_ID
            and inspect(STAGE_TAG, "image")["Id"] == STAGE_ID,
            "TESTED_CANDIDATE_IMAGE_PINNED")
    require(inspect(STAGE_NET, "network").get("Internal") is True,
            "PRIVATE_STAGING_NETWORK")
    require(all(set(c["NetworkSettings"]["Networks"]) == {STAGE_NET}
                for c in (stage, stage_db, stage_redis)),
            "STAGING_NETWORK_ISOLATED")
    live_db_vol = named_volumes(prod_db)
    stage_db_vol = named_volumes(stage_db)
    live_cache_vol = named_volumes(prod_redis)
    stage_cache_vol = named_volumes(stage_redis)
    require(all((live_db_vol, stage_db_vol, live_cache_vol, stage_cache_vol))
            and live_db_vol.isdisjoint(stage_db_vol)
            and live_cache_vol.isdisjoint(stage_cache_vol),
            "LIVE_STAGE_VOLUMES_SEPARATE")

    # Read only three non-secret runtime flags; do not echo Env.
    flags = {}
    for item in prod["Config"].get("Env", []):
        key, _, value = item.partition("=")
        if key in {"AUTH_MODE", "V79_ENTITLEMENT_RECHECK_ENABLED", "NODE_ENV"}:
            flags[key] = value
    require(flags.get("AUTH_MODE") == "hub" and
            flags.get("V79_ENTITLEMENT_RECHECK_ENABLED") == "1" and
            flags.get("NODE_ENV") == "production",
            "LIVE_AUTH_AND_ENTITLEMENTS_ENFORCED")
    print("POS_RELEASE_IDENTITY_AUDIT=PASS")
    print("OFFHOST_BACKUP_AND_DEVICE_SECURITY_RELEASE=SEPARATE_GATES")
    print("PRODUCTION_DEPLOYMENT=NOT_ATTEMPTED")

if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print("POS_RELEASE_AUDIT_FAILED=" + str(error), file=sys.stderr)
        sys.exit(1)

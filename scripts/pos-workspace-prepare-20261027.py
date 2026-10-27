#!/usr/bin/env python3
"""Prepare the reviewed UI on the accepted live POS image; never deploy it.

Run --prepare on Acer after the existing whole-server capture has completed.
Only new build files, image tags and a networkless read-permission probe are
created on Dell. Existing containers/configuration/data are never changed.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import socket
import subprocess
import sys
import tempfile
import urllib.request
import unittest

SOURCE = 'bdda65373d80e4f359b1a4f98b1ef19ca1e12299'
BASE = 'sha256:1020099109eb20dcba462f8b2776714ea1b894ddd0456cdb32121b1a6e7381b0'
SERVER = 'firelion@192.168.100.163'
NAMES = ['v79-pos', 'v79-pos-worker', 'v79-pos-db', 'v79-pos-redis']
OLD = dict(zip(['app.js','app.css','index.html','favicon.svg'], [
 '3bbff18aa3f2c6763326a11ce36cf281651f7b7f784b3817c3f09721b3ddef33',
 '90d1d3ed9cfe52db9538ba26eafde2e8fcdbb8776da8d34ed9672bbd8b9286e2',
 '749c73d3778697d310426ecb8d64516765677a95fe7ea929db0b19524b4d0738',
 '85fb65538fc4c1713726d6d711dbff63b2dd2a4114418eab0bf6a0ea83fee607']))
NEW = dict(zip(OLD, [
 'dcb024de68a659fdf34ae9a0e275c82e221063adfb16a4fbb4aecf9c7d174f00',
 '5332751635529cd32f30428bc0b40b60bcaf046357c12eec4ae6124477747167',
 '0d702f6629273ffa9df4fa7915b1d874af43924abd05da0038c7b80f004ace88',
 '9dd62dc8d41b0535966189c4ebccd28895bc025297d73a0ac0ad650216623f3b']))
PROBE = """const fs=require('fs'),c=require('crypto');const r={};
for(const f of ['app.js','app.css','index.html','favicon.svg'])
r[f]=c.createHash('sha256').update(fs.readFileSync('/app/apps/api/public/'+f)).digest('hex');
console.log(JSON.stringify(r));"""

class Stop(Exception): pass

def run(args, timeout=90, data=None):
    try:
        p = subprocess.run(args, input=data, stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Stop('COMMAND_UNAVAILABLE_OR_TIMEOUT') from None
    if p.returncode:
        raise Stop('COMMAND_FAILED_NO_LIVE_CHANGE_REQUESTED')
    return p.stdout

def read_json(args):
    try: return json.loads(run(args))
    except (ValueError, UnicodeDecodeError): raise Stop('INVALID_COMMAND_JSON') from None

def canonical(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',',':')).encode()).hexdigest()

def validate_live(rows, hashes):
    if len(rows) != len(NAMES): raise Stop('LIVE_SET_INCOMPLETE')
    by_name = {r.get('Name','').lstrip('/'):r for r in rows}
    if set(by_name) != set(NAMES): raise Stop('LIVE_SET_MISMATCH')
    app = by_name['v79-pos']
    if app.get('Image') != BASE: raise Stop('LIVE_IMAGE_CHANGED')
    for name, row in by_name.items():
        if row.get('State',{}).get('Status') != 'running': raise Stop('LIVE_SERVICE_NOT_RUNNING')
        if name != 'v79-pos-worker' and row.get('State',{}).get('Health',{}).get('Status') != 'healthy':
            raise Stop('LIVE_SERVICE_NOT_HEALTHY')
    if app.get('Mounts'): raise Stop('APP_MOUNTS_REQUIRE_REVIEW')
    if hashes != OLD: raise Stop('LIVE_FRONTEND_CHANGED')
    return by_name

def identity(rows):
    return canonical([{k:r.get(k) for k in ['Id','Image','Config','HostConfig','Mounts','NetworkSettings','RestartCount']} for r in rows])

def validate_image(original, candidate):
    a = dict(original.get('Config') or {}); b = dict(candidate.get('Config') or {})
    # Only provenance labels may differ. Runtime command, user, env and health remain identical.
    a.pop('Labels',None); b.pop('Labels',None)
    if a != b: raise Stop('CANDIDATE_RUNTIME_CONFIG_CHANGED')
    layers = original.get('RootFS',{}).get('Layers',[])
    proposed = candidate.get('RootFS',{}).get('Layers',[])
    if not layers or proposed[:len(layers)] != layers or len(proposed) != len(layers)+1:
        raise Stop('CANDIDATE_BASE_LAYERS_CHANGED')

def validate_backup(directory):
    status = directory / 'STATUS'; receipt_file = directory / 'receipt.json'
    if directory.is_symlink() or status.is_symlink() or receipt_file.is_symlink():
        raise Stop('BACKUP_METADATA_SYMLINK')
    if status.read_text().strip() != 'OFFHOST_CIPHERTEXT_VERIFIED_RESTORE_NOT_PROVEN':
        raise Stop('BACKUP_NOT_FINISHED')
    receipt = json.loads(receipt_file.read_text())
    items = receipt.get('plan',{}).get('items',[])
    encrypted = receipt.get('encrypted_items',{})
    if receipt.get('schema') != 'v79-full-offhost-capture-20261027' or not items or len(items) != len(set(items)) or set(items) != set(encrypted):
        raise Stop('BACKUP_RECEIPT_INCOMPLETE')
    for item, info in encrypted.items():
        if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,150}',item): raise Stop('BACKUP_ITEM_INVALID')
        if not isinstance(info,dict) or not isinstance(info.get('bytes'),int) or info['bytes'] <= 0 or not re.fullmatch(r'[a-f0-9]{64}',str(info.get('sha256',''))):
            raise Stop('BACKUP_ITEM_METADATA_INVALID')
        archive = directory / (item.replace(':','__')+'.gpg')
        if archive.is_symlink() or not archive.is_file() or archive.stat().st_size != info['bytes']:
            raise Stop('BACKUP_ARCHIVE_MISSING_OR_SIZE_CHANGED')
    # Existing capture already checked ciphertext hashes/decryption. Do not repeat it here.
    return canonical(receipt)

def acer_prepare():
    if socket.gethostname().split('.')[0] != 'firelion-Aspire-A315-51': raise Stop('RUN_ON_ACER')
    root = Path.home()/'V79-Full-Recovery'
    statuses = sorted(root.glob('full-*/STATUS'))
    if root.is_symlink() or any(p.is_symlink() for p in statuses): raise Stop('BACKUP_METADATA_SYMLINK')
    if not statuses: raise Stop('BACKUP_STATUS_NOT_FOUND')
    if any(p.read_text().strip() == 'IN_PROGRESS' for p in statuses): raise Stop('WAIT_BACKUP_IN_PROGRESS')
    receipt_hash = validate_backup(statuses[-1].parent)
    print('EXISTING_BACKUP_METADATA=COMPLETE_NO_RETEST',flush=True)
    command = 'sg docker -c '+shlex.quote('python3 - --server-prepare --backup-receipt-sha '+receipt_hash)
    # Only redacted status/receipt metadata comes back, never inspect secrets or build logs.
    result = subprocess.run(['ssh','-o','StrictHostKeyChecking=yes',SERVER,command], timeout=900,
                            input=Path(__file__).resolve().read_bytes(), check=False)
    if result.returncode: raise Stop('SERVER_PREPARATION_NOT_COMPLETE')


def server_prepare(backup_receipt_sha):
    os.umask(0o077)
    if socket.gethostname().split('.')[0] != 'v79sl': raise Stop('WRONG_SERVER')
    if os.getenv('DOCKER_HOST') or os.getenv('DOCKER_CONTEXT'): raise Stop('REMOTE_DOCKER_REFUSED')
    context = read_json(['docker','context','inspect'])
    if len(context)!=1 or context[0].get('Endpoints',{}).get('docker',{}).get('Host') not in ['unix:///var/run/docker.sock','unix:///run/docker.sock']:
        raise Stop('NONLOCAL_DOCKER')
    if not re.fullmatch(r'[a-f0-9]{64}',backup_receipt_sha or ''): raise Stop('BACKUP_RECEIPT_REQUIRED')
    rows = read_json(['docker','inspect',*NAMES])
    hashes = read_json(['docker','exec','v79-pos','node','-e',PROBE])
    by_name = validate_live(rows,hashes)
    before = identity(rows)
    if (os.statvfs(Path.home()).f_bavail * os.statvfs(Path.home()).f_frsize) < 2*1024**3:
        raise Stop('LOW_FREE_SPACE')
    work = Path(tempfile.mkdtemp(prefix='v79-pos-workspace-stage-',dir=Path.home()))
    for name, digest in NEW.items():
        url = 'https://raw.githubusercontent.com/MrFixITslu/V79POS/'+SOURCE+'/apps/api/public/'+name
        try:
            with urllib.request.urlopen(url,timeout=45) as response: content=response.read(600001)
        except Exception: raise Stop('PINNED_ASSET_DOWNLOAD_FAILED') from None
        if len(content)>600000 or hashlib.sha256(content).hexdigest()!=digest: raise Stop('PINNED_ASSET_HASH_MISMATCH')
        path=work/name;path.write_bytes(content);path.chmod(0o644)
    base_tag='v79-pos-workspace-base:1020099109eb-'+work.name.rsplit('-',1)[-1]
    tag='v79-pos-workspace-candidate:'+SOURCE[:12]+'-'+work.name.rsplit('-',1)[-1]
    # Tags reference the accepted immutable local image; no registry pull or generic rebuild.
    run(['docker','image','tag',BASE,base_tag])
    if read_json(['docker','image','inspect',base_tag])[0]['Id']!=BASE: raise Stop('BASE_TAG_RACE')
    (work/'Dockerfile').write_text('FROM '+base_tag+'\nCOPY --chown=node:node app.js app.css index.html favicon.svg /app/apps/api/public/\n')
    run(['docker','build','--pull=false','--network=none','-t',tag,str(work)],timeout=600)
    original = read_json(['docker','image','inspect',BASE])[0]
    candidate = read_json(['docker','image','inspect',tag])[0]
    validate_image(original,candidate)
    check = read_json(['docker','run','--rm','--pull','never','--network','none','--read-only',
        '--cap-drop','ALL','--security-opt','no-new-privileges','--pids-limit','64',
        '--memory','128m','--cpus','1','--user','node','--entrypoint','node',candidate['Id'],'-e',PROBE])
    if check!=NEW: raise Stop('CANDIDATE_ASSET_OR_PERMISSION_FAILURE')
    after = read_json(['docker','inspect',*NAMES])
    if identity(after)!=before: raise Stop('LIVE_RUNTIME_CHANGED_DURING_PREPARATION')
    # Record only hashes/identities and Compose locations; never persist environment secret values.
    labels=by_name['v79-pos'].get('Config',{}).get('Labels') or {}
    receipt={'schema':'v79-pos-workspace-stage-20261027','prepared_at_utc':dt.datetime.now(dt.timezone.utc).isoformat(),
        'ui_source':SOURCE,'base_image':BASE,'candidate_image':candidate['Id'],'candidate_tag':tag,
        'original_runtime_digest':before,'original_container_ids':{n:by_name[n]['Id'] for n in NAMES},
        'compose_project':labels.get('com.docker.compose.project'),
        'compose_service':labels.get('com.docker.compose.service'),
        'compose_workdir':labels.get('com.docker.compose.project.working_dir'),
        'compose_files':labels.get('com.docker.compose.project.config_files'),
        'assets':NEW,'backup_receipt_sha256':backup_receipt_sha,'deployed':False}
    receipt_path=work/'stage-result.json';receipt_path.write_text(json.dumps(receipt,indent=2)+'\n')
    print('CANDIDATE_PREPARATION=PASS_EXACT_LIVE_BASE')
    print('CANDIDATE_IMAGE='+candidate['Id'])
    print('STAGE_RECEIPT='+str(receipt_path))
    print('LIVE_POS_WORKER_DB_REDIS=UNCHANGED')
    print('DEPLOYED=NO')

class SafetyTests(unittest.TestCase):
    def test_config_or_layer_drift_rejected(self):
        base={'Config':{'User':'node','Cmd':['node','server.js']},'RootFS':{'Layers':['a']}}
        good={'Config':dict(base['Config']),'RootFS':{'Layers':['a','ui']}}
        validate_image(base,good)
        bad=json.loads(json.dumps(good));bad['Config']['User']='root'
        with self.assertRaises(Stop):validate_image(base,bad)
        bad=json.loads(json.dumps(good));bad['RootFS']['Layers']=['wrong','ui']
        with self.assertRaises(Stop):validate_image(base,bad)
    def test_live_image_hash_and_mount_drift_rejected(self):
        rows=[{'Name':'/'+n,'Image':BASE,'State':{'Status':'running','Health':{'Status':'healthy'}},'Mounts':[]} for n in NAMES]
        validate_live(rows,OLD)
        for key,value in [('Image','wrong'),('Mounts',[{'Destination':'/app'}])]:
            bad=json.loads(json.dumps(rows));bad[0][key]=value
            with self.assertRaises(Stop):validate_live(bad,OLD)
        with self.assertRaises(Stop):validate_live(rows,NEW)
    def test_incomplete_backup_rejected_without_archive_retest(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp);(p/'STATUS').write_text('IN_PROGRESS')
            with self.assertRaises(Stop):validate_backup(p)
            (p/'STATUS').write_text('OFFHOST_CIPHERTEXT_VERIFIED_RESTORE_NOT_PROVEN')
            (p/'receipt.json').write_text(json.dumps({'schema':'v79-full-offhost-capture-20261027','plan':{'items':['images']},'encrypted_items':{}}))
            with self.assertRaises(Stop):validate_backup(p)
            (p/'images.gpg').write_bytes(b'x')
            (p/'receipt.json').write_text(json.dumps({'schema':'v79-full-offhost-capture-20261027','plan':{'items':['images']},'encrypted_items':{'images':{'sha256':'a'*64,'bytes':1}}}))
            validate_backup(p)

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    mode=parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--self-test',action='store_true');mode.add_argument('--prepare',action='store_true')
    mode.add_argument('--server-prepare',action='store_true',help=argparse.SUPPRESS)
    parser.add_argument('--backup-receipt-sha',help=argparse.SUPPRESS)
    args=parser.parse_args()
    if args.self_test:
        return 0 if unittest.TextTestRunner().run(unittest.defaultTestLoader.loadTestsFromTestCase(SafetyTests)).wasSuccessful() else 1
    try:
        if args.prepare:acer_prepare()
        else:server_prepare(args.backup_receipt_sha)
        return 0
    except Stop as exc:print('STOP='+str(exc));return 2
    except Exception:print('STOP=REDACTED_PREPARATION_FAILURE');return 2

if __name__=='__main__':sys.exit(main())

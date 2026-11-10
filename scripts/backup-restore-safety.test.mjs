// All PostgreSQL clients are local fakes; never accesses production.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root = mkdtempSync(join(tmpdir(), 'v79-pos-backup-safety-'));
const bin = join(root, 'bin');
const data = join(root, 'data');
mkdirSync(bin);
mkdirSync(data);
const ledger = join(root, 'restore_called.txt');
const fake = (name, source) => {
  const file = join(bin, name);
  writeFileSync(file, '#!/bin/sh\n' + source + '\n', { mode: 0o700 });
  chmodSync(file, 0o700);
};
fake('pg_dump',
  'if [ "$FAKE_PGDUMP_FAIL" = "1" ]; then exit 44; fi\n' +
  'for arg in "$@"; do case "$arg" in --file=*) file="${arg#--file=}"; printf "FAKE_ARCHIVE\\n" > "$file";; esac; done');
fake('psql',
  'case "$*" in *current_database*) echo "v79pos_restore_smoke";; *pg_tables*) echo "$FAKE_RESTORE_TABLES";; *) echo "0";; esac');
fake('pg_restore', 'printf "CALLED\\n" >> "$FAKE_RESTORE_LEDGER"');
const env = {
  ...process.env, PATH: bin + ':' + process.env.PATH,
  FAKE_PGDUMP_FAIL: '0', FAKE_RESTORE_TABLES: '0', FAKE_RESTORE_LEDGER: ledger,
  BACKUP_DIR: data, DATABASE_URL: 'postgresql://test:test@127.0.0.1:55479/fake'
};
function call(name, overrides = {}) {
  const result = spawnSync('sh', [resolve('scripts', name)], {
    env: { ...env, ...overrides }, encoding: 'utf-8'
  });
  return { status: result.status, out: (result.stdout || '') + (result.stderr || '') };
}
try {
  assert.equal(spawnSync('sh', ['-n','scripts/backup.sh']).status, 0);
  assert.equal(spawnSync('sh', ['-n','scripts/restore-test.sh']).status, 0);
  const old = join(data, 'v79commerce-old.dump');
  writeFileSync(old, 'PREVIOUS_BACKUP');
  const backup = call('backup.sh');
  assert.equal(backup.status, 0, backup.out);
  const dumps = readdirSync(data).filter(x => x.endsWith('.dump') && !x.includes('old'));
  assert.equal(dumps.length, 1);
  assert.equal(readFileSync(old, 'utf-8'), 'PREVIOUS_BACKUP');
  const file = join(data, dumps[0]);
  assert.equal(statSync(file).mode & 0o077, 0);
  assert.equal(statSync(file + '.sha256').mode & 0o077, 0);
  assert.ok(!readdirSync(data).some(x => x.includes('.partial.')));
  assert.notEqual(call('backup.sh', { FAKE_PGDUMP_FAIL:'1' }).status,0);
  const input = {
    RESTORE_DATABASE_URL: 'postgresql://test:test@127.0.0.1:55479/v79pos_restore_smoke',
    BACKUP_FILE:file, RESTORE_DRILL_CONFIRM:'disposable-local-db'
  };
  for (const overrides of [
    { RESTORE_DRILL_CONFIRM:'' },
    { RESTORE_DATABASE_URL:'postgresql://test:test@v79sl:5432/v79pos_restore_smoke' },
    { RESTORE_DATABASE_URL:'postgresql://test:test@127.0.0.1:5432/v79pos_restore_smoke' },
    { RESTORE_DATABASE_URL:'postgresql://test:test@127.0.0.1:55479/v79commerce' },
    { RESTORE_DATABASE_URL:'postgresql://test:test@127.0.0.1:55479/postgres' },
    { FAKE_RESTORE_TABLES:'1' }
  ]) {
    const denied = call('restore-test.sh', { ...input, ...overrides });
    assert.notEqual(denied.status,0,JSON.stringify(overrides));
    assert.ok(!readdirSync(root).includes('restore_called.txt'));
  }
  const restored = call('restore-test.sh',input);
  assert.equal(restored.status,0,restored.out);
  assert.match(restored.out,/POS_RESTORE_DRILL=PASS/);
  assert.equal(readFileSync(ledger,'utf-8').trim(),'CALLED');
  console.log('PASS: private backups, preserved recovery points, restore safety guards');
} finally {
  rmSync(root,{recursive:true,force:true});
}

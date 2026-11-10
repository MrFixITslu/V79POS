// Regression tests for the real POS Team response and admin technician stock view.
// Pure local checks: no credentials, network, Docker or customer writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync('apps/api/public/app.js','utf8');
const teamAPI = readFileSync('apps/api/src/modules/team/routes.ts','utf8');
const authContext = readFileSync('apps/api/src/modules/auth/context.ts','utf8');

const extract = (start, end) => {
  const p = source.indexOf(start);
  assert.ok(p >= 0, 'missing source declaration ' + start);
  const q = source.indexOf(end, p + start.length);
  assert.ok(q > p, 'missing function end delimiter ' + end);
  return source.slice(p, q).trim();
};
const normalise = runInNewContext('(' + extract('function normalizeLoadedData(key, body) {', '\nfunction registerCloseReconciliation(') + ')');

const team = {members:[{userId:'tech1',active:true,roleKey:'TECHNICIAN'}]};
assert.equal(normalise('team',team).members.length,1,'team must retain members envelope');
assert.equal(normalise('team',team).members[0].userId,'tech1');
assert.throws(()=>normalise('team',{team:[]}),/Team response is invalid/);
assert.equal(normalise('inventory',{inventory:[{id:'i1'}]}).length,1);
assert.equal(normalise('stockCounts',{counts:[]}).length,0);

assert.match(teamAPI,/return \{ members: await prisma\.membership\.findMany\(/,
  'Team API contract must expose members');
assert.match(source,/key === "team" \? \{ members: \[\] \}/,
  'Unauthorised UI must not fabricate loaded team records');

const visible = extract('function visibleTabs() {', '\nfunction navButton(');
const navTest = role => runInNewContext('(' + visible + ')', {
  tabs:[['overview','Overview'],['technician-stock','Technician Inventory']],
  can:()=>true,
  state:{me:{roleKey:role}}
})();
assert.equal(navTest('OWNER').some(([id])=>id==='technician-stock'),true);
assert.equal(navTest('ADMIN').some(([id])=>id==='technician-stock'),true);
assert.equal(navTest('MANAGER').some(([id])=>id==='technician-stock'),true);
for(const role of ['TECHNICIAN','CASHIER','INVENTORY','SUPERVISOR']) {
  assert.equal(navTest(role).some(([id])=>id==='technician-stock'),false,
    'Admin technician stock view leaked to '+role);
}
assert.match(source, /"technician-stock": \["team", "inventory", "locations", "transfers"\]/);
assert.match(source, /"technician-stock": technicianStock/);
assert.match(authContext,/TECHNICIAN: \['inventory\.technician','shifts\.use'\]/,
  'Existing technician role permissions must remain unchanged');

const technicianView = runInNewContext('(' +
  extract('function technicianStock() {', '\nfunction stockControl() {') + ')', {
  state:{me:{roleKey:'OWNER'},data:{
    team:{members:[{userId:'t-1',roleKey:'TECHNICIAN',active:true,
      profile:{displayName:'Technician Test'},locationAccess:[{locationId:'mobile1'}]}]},
    locations:[{id:'mobile1',name:'Test Mobile',type:'MOBILE'}],
    inventory:[{locationId:'mobile1',onHand:'3',available:'2',
      location:{name:'Test Mobile'},productVariant:{product:{name:'Cable'},sku:'C-1'}}],
    transfers:[{number:'TR-1',status:'REQUESTED',purpose:'TECHNICIAN_ISSUE',
      fromLocation:{name:'Warehouse'},toLocation:{name:'Test Mobile'},
      createdAt:'2026-11-10T00:00:00Z',jobReference:'TQ-1'}]
  }},
  can:(p)=>p==='inventory.read'||p==='team.read'||p==='inventory.transfer',
  header:(title)=>title,
  needs:(permission)=>permission,
  metric:(label,value)=>label+':'+value,
  table:(_,rows)=>rows.join(''),
  empty:(s)=>s,
  round:(v)=>Math.round(v*100)/100,
  date:(v)=>v,
  badge:(v)=>v,
  h:(v)=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;')
});
const html=technicianView();
for(const expected of ['Assigned technicians:1','Mobile stock locations:1',
  'Units on hand:3','Pending movements:1','Technician Test','Cable',
  'TQ-1','data-modal="technician-access"']) {
  assert.ok(html.includes(expected),'missing visible technician detail: '+expected);
}
assert.ok(!html.includes('Sample business'),'Do not fabricate inventory data');

console.log('PASS: Team API envelope, owner-only technician nav, real custody and role permissions');

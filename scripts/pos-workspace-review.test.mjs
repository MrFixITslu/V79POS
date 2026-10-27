import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
const source=fs.readFileSync('apps/api/public/app.js','utf8');
const fields={'/v1/products':'products','/v1/registers':'registers','/v1/inventory':'inventory','/v1/locations':'locations','/v1/transfers':'transfers','/v1/stock-counts':'stockCounts','/v1/customers':'customers','/v1/sales':'sales','/v1/orders':'orders','/v1/suppliers':'suppliers','/v1/purchase-orders':'purchaseOrders','/v1/replenishment':'recommendations'};
async function setup({permissions=['*'],failed=[],malformed=false,appearance=null}={}){
 const handlers={},requests=[],storage=new Map(appearance?[['v79-pos-theme',appearance]]:[]);
 const root={innerHTML:'',addEventListener:(name,fn)=>handlers[name]=fn};
 const toast={textContent:'',classList:{toggle(){},remove(){}}};
 const doc={title:'',documentElement:{dataset:{}},querySelector:selector=>selector==='#app'?root:selector==='#toast'?toast:{focus(){}},addEventListener(){}};
 const context=vm.createContext({document:doc,Intl,console,crypto:{randomUUID},URLSearchParams,
 localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},sessionStorage:{getItem(){return null}},
 history:{state:null},location:{hash:'',pathname:'/',search:''},window:{opener:null,addEventListener(){}},
 setTimeout:()=>0,clearTimeout(){},
 fetch:async (url,options={})=>{requests.push({url,method:options.method||'GET'});const pathname=url.split('?')[0];
  if(pathname==='/v1/me') return {ok:true,json:async()=>({tenantId:'synthetic',roleKey:'OWNER',permissions})};
  if(failed.includes(pathname)) return {ok:false,status:503,json:async()=>({message:'Synthetic read unavailable'})};
  const fixture=vm.runInContext('demoData()',context);
  if(pathname==='/v1/reports/dashboard')return {ok:true,json:async()=>malformed?{}:fixture.dashboard};
  const field=fields[pathname];if(!field)throw Error('Unexpected URL '+url);
  return {ok:true,json:async()=>({[field==='stockCounts'?'counts':field]:fixture[field]||[]})};
 }});
 vm.runInContext(source,context);
 await new Promise(resolve=>setImmediate(resolve));
 return {context,doc,root,requests,handlers,storage,run:code=>vm.runInContext(code,context)};
}
test('all ten real view functions render and role-filtered shell identifies POS',async()=>{
 const x=await setup();
 for(const page of x.run('Object.keys(pages)')) {
  x.run(`state.page=${JSON.stringify(page)};render()`);
  assert.match(x.root.innerHTML,/<h1>/,page);
  assert.match(x.doc.title,/Vision79 POS/);
 }
 assert.ok(x.requests.every(r=>r.method==='GET'));
 assert.match(x.root.innerHTML,/Sell & serve/);
 assert.match(x.root.innerHTML,/Stock & supply/);
});
test('restricted role sees only its sections and cannot navigate to hidden register',async()=>{
 const x=await setup({permissions:['sales.read','customers.read']});
 assert.deepEqual([...x.run('visibleTabs().map(x=>x[0])')],['customers','sales']);
 const before=x.run('state.page');
 await x.handlers.click({target:{closest:()=>({dataset:{page:'register'}})}});
 assert.equal(x.run('state.page'),before);
 assert.doesNotMatch(x.root.innerHTML,/data-page="register"/);
});
test('failed report never looks like zero sales or healthy stock; retry remains visible',async()=>{
 const x=await setup({failed:['/v1/reports/dashboard','/v1/sales']});
 assert.match(x.root.innerHTML,/Retry loading/);
 assert.match(x.root.innerHTML,/Stock signals unavailable/);
 assert.match(x.root.innerHTML,/Sales history is unavailable/);
 assert.equal((x.root.innerHTML.match(/<strong>Unavailable<\/strong>/g)||[]).length,7);
 assert.doesNotMatch(x.root.innerHTML,/No critical replenishment signals|>LIVE<|Operational/);
});
test('missing numeric report fields remain unavailable while true zero stays zero',async()=>{
 const x=await setup({malformed:true});
 assert.match(x.root.innerHTML,/Stock signals unavailable/);
 assert.equal(x.run('reportValue(0)'), '0');
 assert.equal(x.run('reportValue(null)'), 'Unavailable');
 assert.equal(x.run('reportValue(undefined)'), 'Unavailable');
 assert.equal(x.run('reportValue(" ")'), 'Unavailable');
});
test('saved appearance applies and toggling preserves the current cart without API writes',async()=>{
 const x=await setup({appearance:'dark'});
 assert.equal(x.doc.documentElement.dataset.theme,'dark');
 x.run('state.cart=[{id:"v1",quantity:2}]');const before=x.requests.length;
 await x.handlers.click({target:{closest:()=>({dataset:{action:'theme'}})}});
 assert.equal(x.doc.documentElement.dataset.theme,'light');
 assert.equal(x.storage.get('v79-pos-theme'),'light');
 assert.equal(x.run('state.cart[0].quantity'),2);
 assert.equal(x.requests.length,before);
});
test('all referenced same-origin assets use the existing public route allowlist',()=>{
 const html=fs.readFileSync('apps/api/public/index.html','utf8');
 const refs=[...html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)].map(m=>m[1]);
 for(const asset of refs)assert.ok(['/app.js','/app.css','/favicon.svg'].includes(asset),asset);
 assert.doesNotMatch(source,/src="\/(?:pos-icon|pos-logo|theme|workspace)/);
 const server=fs.readFileSync('apps/api/src/server.ts','utf8');
 for(const asset of refs)assert.ok(server.includes(`['${asset}'`),asset);
});

test('failed register data hides checkout controls and failed lists never claim to be empty',async()=>{
 const x=await setup({failed:['/v1/registers','/v1/stock-counts','/v1/customers']});
 for(const page of ['register','stock-control','customers']) {
  x.run(`state.page=${JSON.stringify(page)};render()`);
  assert.match(x.root.innerHTML,/Data unavailable/);
  assert.match(x.root.innerHTML,/Retry this section/);
  assert.doesNotMatch(x.root.innerHTML,/data-action="checkout"|No stock counts yet|No customers yet/);
 }
});

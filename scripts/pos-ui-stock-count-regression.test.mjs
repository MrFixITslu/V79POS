import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

const filename=process.env.POS_UI_FILE||path.resolve('apps/api/public/app.js');
const source=fs.readFileSync(filename,'utf8');
const loader=source.slice(source.indexOf('function normalizeLoadedData('),source.indexOf('function field('));
const stockView=source.slice(source.indexOf('function stockControl()'),source.indexOf('function customers()'));
const currency=source.slice(source.indexOf('const cash ='),source.indexOf('const date ='));
const paths={
 '/v1/products':'products','/v1/registers':'registers','/v1/inventory':'inventory','/v1/locations':'locations',
 '/v1/transfers':'transfers','/v1/customers':'customers','/v1/sales':'sales','/v1/orders':'orders',
 '/v1/suppliers':'suppliers','/v1/purchase-orders':'purchaseOrders','/v1/replenishment':'recommendations'};

function setup({allowed=true,counts={counts:[]},responses={}}={}){
 const messages=[],requests=[],state={demo:false,me:{roleKey:'owner'},data:{},selectedRegister:'',lastRegisterClose:null};
 const context=vm.createContext({state,Intl,Error,Array,Number,String,
  can:()=>allowed,toast:message=>messages.push(message),h:value=>String(value??''),date:()=>'',
  header:()=>'',badge:x=>x,empty:x=>x,needs:()=>'',table:(_headers,rows)=>rows.join(''),
  api:async url=>{requests.push(url);if(Object.hasOwn(responses,url))return responses[url];if(url==='/v1/stock-counts')return counts;
   if(url==='/v1/reports/dashboard')return {sales:{netRevenue:0}};
   return {[paths[url.split('?')[0]]]:[]};},demoData:()=>({})});
 vm.runInContext(currency+loader+stockView+source.slice(source.indexOf('function currentRegister()'),source.indexOf('function totals()')),context);
 return {context,state,messages,requests};
}

test('real counts envelope loads populated and empty lists without stock-control crash',async()=>{
 const x=setup({counts:{counts:[{id:'count-1',number:'COUNT-1',status:'COMPLETED',locationId:'loc-1',type:'CYCLE'}]}});
 await vm.runInContext('load()',x.context);
 assert.equal(x.state.data.stockCounts[0].id,'count-1');
 assert.match(vm.runInContext('stockControl()',x.context),/COUNT-1/);
 assert.equal(x.messages.length,0);
 const empty=setup();await vm.runInContext('load()',empty.context);
 assert.ok(Array.isArray(empty.state.data.stockCounts));
 assert.match(vm.runInContext('stockControl()',empty.context),/No stock counts yet/);
});
test('permission-denied collections are arrays and make no unauthorized API calls',async()=>{
 const x=setup({allowed:false});await vm.runInContext('load()',x.context);
 assert.equal(x.requests.length,0);
 for(const [key,value]of Object.entries(x.state.data))if(key!=='dashboard')assert.ok(Array.isArray(value),key);
 assert.doesNotThrow(()=>vm.runInContext('stockControl()',x.context));
});
test('malformed counts report an error and preserve an already valid list',async()=>{
 const x=setup({counts:{counts:{not:'an array'}}});
 x.state.data.stockCounts=[{id:'kept',number:'KEPT',status:'COMPLETED'}];
 await vm.runInContext('load()',x.context);
 assert.equal(x.state.data.stockCounts[0].id,'kept');
 assert.ok(x.messages.some(m=>/stockCounts response is invalid/.test(m)));
 assert.match(vm.runInContext('stockControl()',x.context),/KEPT/);
});
test('raw/legacy lists work and invalid dashboard shapes reject',()=>{
 const x=setup();
 assert.ok(vm.runInContext('Array.isArray(normalizeLoadedData("stockCounts", []))',x.context));
 assert.ok(vm.runInContext('Array.isArray(normalizeLoadedData("stockCounts", {stockCounts:[]}))',x.context));
 assert.throws(()=>vm.runInContext('normalizeLoadedData("dashboard", [])',x.context),/Dashboard response is invalid/);
});
test('closed register shows server expected/count cash and exact server variance',()=>{
 const x=setup();x.state.lastRegisterClose={status:'CLOSED',registerId:'reg-1',expectedCash:'110.00',closingCash:'105.00',cashVariance:'-5.00'};
 const html=vm.runInContext('registerCloseReconciliation({id:"reg-1",sessions:[]})',x.context);
 assert.match(html,/Expected cash/);assert.match(html,/Counted cash/);assert.match(html,/Variance/);
 assert.match(html,/110\.00/);assert.match(html,/105\.00/);assert.match(html,/-[^<]*5\.00/);
});
test('missing amounts never appear as zero and another/open register shows no old summary',()=>{
 const x=setup();x.state.lastRegisterClose={status:'CLOSED',registerId:'reg-1',expectedCash:null,closingCash:'0',cashVariance:'0'};
 assert.match(vm.runInContext('registerCloseReconciliation({id:"reg-1",sessions:[]})',x.context),/amounts are unavailable/);
 assert.equal(vm.runInContext('registerCloseReconciliation({id:"other",sessions:[]})',x.context),'');
 assert.equal(vm.runInContext('registerCloseReconciliation({id:"reg-1",sessions:[{id:"open"}]})',x.context),'');
});
test('refresh reads an existing closed-session receipt without repeating transactions',async()=>{
 const x=setup({responses:{
  '/v1/registers':{registers:[{id:'reg-1',sessions:[]}]},
  '/v1/sales?limit=50':{sales:[{registerId:'reg-1',registerSessionId:'session-1'}]},
  '/v1/register-sessions/session-1/reconciliation':{session:{id:'session-1',registerId:'reg-1',status:'CLOSED',expectedCash:'110',closingCash:'110',cashVariance:'0'}}
 }});
 await vm.runInContext('load()',x.context);
 assert.ok(x.requests.includes('/v1/register-sessions/session-1/reconciliation'));
 assert.equal(x.state.lastRegisterClose.cashVariance,'0');
 assert.match(vm.runInContext('registerCloseReconciliation({id:"reg-1",sessions:[]})',x.context),/Variance/);
});

/* Synthetic UI review only. No live endpoints, credentials, sales, refunds or device tests. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { chromium } = require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES + '/playwright' : 'playwright');
const source = fs.readFileSync('apps/api/public/app.js', 'utf8');
const fixture = vm.runInNewContext(source.slice(source.indexOf('function demoData()'), source.indexOf('async function api(')) + '\ndemoData()');
const out = process.env.POS_VISUAL_OUTPUT || '/tmp/v79-pos-visual';
fs.mkdirSync(out, {recursive:true});
const pages = ['overview','register','products','inventory','stock-control','customers','sales','orders','purchasing','replenishment'];
const paths = {'/v1/products':'products','/v1/registers':'registers','/v1/inventory':'inventory','/v1/locations':'locations','/v1/transfers':'transfers','/v1/stock-counts':'stockCounts','/v1/customers':'customers','/v1/sales':'sales','/v1/orders':'orders','/v1/suppliers':'suppliers','/v1/purchase-orders':'purchaseOrders','/v1/replenishment':'recommendations'};
let screenshots=0;
const server = http.createServer((req,res)=>{
  const asset = req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0].slice(1);
  if (!/^[\w.-]+$/.test(asset)) {res.writeHead(404); return res.end();}
  if (!['index.html','app.css','app.js','favicon.svg'].includes(asset)) {res.writeHead(404); return res.end();}
  const file=path.join('apps/api/public',asset);
  if (!fs.existsSync(file)) {res.writeHead(404);return res.end();}
  res.setHeader('Content-Type', ({'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml'})[path.extname(file)] || 'text/plain');
  res.end(fs.readFileSync(file));
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const launchOptions = {headless:true};
  if (process.env.POS_PORTABLE_CHROMIUM === '1') {
    const {default:portable} = await import(require.resolve('@sparticuz/chromium'));
    launchOptions.executablePath = await portable.executablePath();
    launchOptions.args = ['--no-sandbox','--no-zygote','--disable-gpu'];
  }
  const browser=await chromium.launch(launchOptions);
  const errors=[],unexpected=[];
  async function open({width=1440, theme='light', permissions=['*'], failed=[], malformed=false, anonymous=false}={}) {
    const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce'});
    await context.addInitScript(theme=>{ if (!localStorage.getItem('v79-pos-theme')) localStorage.setItem('v79-pos-theme',theme); },theme);
    const page=await context.newPage();
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*', async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin!==origin){unexpected.push(request.url());return route.abort();}
      if(url.pathname.startsWith('/v1/') || url.pathname.startsWith('/auth/')) {
        assert.equal(request.method(),'GET','Visual QA must never write');
        if(url.pathname==='/v1/me') return route.fulfill({status:anonymous?401:200,json:anonymous?{error:'Signed out'}:{tenantId:'synthetic-business',roleKey:'OWNER',permissions}});
        if(failed.includes(url.pathname)) return route.fulfill({status:503,json:{message:'Synthetic unavailable'}});
        if(url.pathname==='/v1/reports/dashboard') return route.fulfill({json:malformed?{}:fixture.dashboard});
        const k=paths[url.pathname];
        if(!k){unexpected.push(url.pathname);return route.fulfill({status:404,json:{error:'Unexpected synthetic read'}});}
        return route.fulfill({json:{[k==='stockCounts'?'counts':k]:fixture[k]||[]}});
      }
      return route.continue();
    });
    await page.goto(origin);
    await page.locator(anonymous?'.login-card':'.shell').waitFor();
    return {page,context};
  }
  try {
    for(const width of [1440,390]) {
      for(const theme of ['light','dark']) {
        const {page,context}=await open({width,theme});
        for(const id of pages) {
          await page.locator(`.nav [data-page="${id}"]`).click();
          await page.locator('#main h1').waitFor();
          if(width < 600) {
            const visible=await page.locator('.nav [aria-current="page"]').evaluate(el=>{
              const a=el.getBoundingClientRect(),b=el.closest('.nav').getBoundingClientRect();
              return a.left >= b.left-1 && a.right <= b.right+1;
            });
            assert.equal(visible,true,`${id} selected mobile tab remains visible`);
            assert.equal(await page.locator('.table-wrap').evaluateAll(nodes=>nodes.every(n=>n.scrollWidth<=n.clientWidth+1)),true,`${id} records need no horizontal scroll`);
          }
          assert.match(await page.title(),/Vision79 POS/);
          const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1);
          assert.equal(overflow,false,`${id} ${width} ${theme} viewport overflow`);
          await page.screenshot({path:path.join(out,`${width}-${theme}-${id}.png`),fullPage:true});screenshots++;
        }
        await context.close();
      }
    }
    const restricted=await open({permissions:['sales.read','customers.read']});
    assert.equal(await restricted.page.locator('.nav [data-page]').count(),2);
    assert.equal(await restricted.page.locator('[data-page="register"]').count(),0);
    await restricted.context.close();
    const failed=await open({failed:['/v1/reports/dashboard','/v1/sales']});
    assert.equal(await failed.page.locator('.metric strong').filter({hasText:'Unavailable'}).count(),4);
    assert.match(await failed.page.locator('.ops-banner').innerText(),/Stock signals unavailable/);
    await failed.page.getByRole('button',{name:'Retry loading',exact:true}).waitFor();
    await failed.page.screenshot({path:path.join(out,'failed-data.png'),fullPage:true});screenshots++;
    await failed.context.close();
    const unsafe=await open({failed:['/v1/registers','/v1/stock-counts']});
    for(const id of ['register','stock-control']) {
      await unsafe.page.locator(`.nav [data-page="${id}"]`).click();
      assert.match(await unsafe.page.locator('#main').innerText(),/Data unavailable/);
      assert.equal(await unsafe.page.locator('[data-action="checkout"]').count(),0);
    }
    await unsafe.context.close();
    const malformed=await open({malformed:true});
    assert.equal(await malformed.page.locator('.metric strong').filter({hasText:'Unavailable'}).count(),4);
    await malformed.context.close();
    const preference=await open();
    await preference.page.getByRole('button',{name:'Switch to dark appearance'}).click();
    assert.equal(await preference.page.evaluate(()=>document.documentElement.dataset.theme),'dark');
    await preference.page.reload();
    await preference.page.locator('.shell').waitFor();
    assert.equal(await preference.page.evaluate(()=>document.documentElement.dataset.theme),'dark');
    await preference.context.close();
    const direct=await open({anonymous:true,width:390});
    await direct.page.screenshot({path:path.join(out,'direct-visitor-mobile.png'),fullPage:true});screenshots++;
    assert.equal(await direct.page.locator('.logo-large svg').count(),1);
    await direct.context.close();
    assert.deepEqual(errors,[],'No JavaScript runtime errors');
    assert.deepEqual(unexpected,[],'No external or unexpected API traffic');
    console.log(JSON.stringify({status:'PASS',screenshots,pages:pages.length,viewports:[1440,390],themes:['light','dark'],restrictedNavigation:true,failedData:true,malformedDashboard:true,savedAppearance:true,externalRequests:0,scope:'Synthetic UI only; no live SSO, merchant acceptance or deployment'}));
  } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});

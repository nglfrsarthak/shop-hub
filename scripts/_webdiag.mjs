// Diagnostic: load the console in a real browser, sign in, walk the nav, and
// report every console message and failed request. The server log only shows
// what arrived; this shows what the page did with it.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const APP = process.env.APP ?? 'http://127.0.0.1:3010';
const PORT = 9333;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const proc = spawn(EDGE, [
  `--user-data-dir=C:\\Users\\sarth\\shop-hub\\.shot-diag`,
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, '--window-size=1500,1000', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let list = null;
  for (let i = 0; i < 40 && !list; i += 1) {
    await sleep(500);
    try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* not up yet */ }
  }
  if (!list) throw new Error('browser never came up');

  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  let n = 0; const m = new Map();
  const console_ = [];
  ws.addEventListener('message', (e) => {
    const x = JSON.parse(e.data);
    if (x.id && m.has(x.id)) { const y = m.get(x.id); m.delete(x.id); x.error ? y.rej(new Error(x.error.message)) : y.res(x.result); return; }
    if (x.method === 'Runtime.consoleAPICalled') {
      console_.push(`[console.${x.params.type}] ${x.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
    }
    if (x.method === 'Runtime.exceptionThrown') {
      const d = x.params.exceptionDetails;
      console_.push(`[EXCEPTION] ${d.exception?.description ?? d.text}`);
    }
    if (x.method === 'Log.entryAdded' && x.params.entry.level === 'error') {
      console_.push(`[log] ${x.params.entry.text} ${x.params.entry.url ?? ''}`);
    }
  });
  const send = (method, params = {}) => { const id = ++n; return new Promise((res, rej) => { m.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); }); };
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });

  const failures = [];
  ws.addEventListener('message', (e) => {
    const x = JSON.parse(e.data);
    if (x.method === 'Network.loadingFailed') failures.push(`${x.params.type} ${x.params.errorText}`);
    if (x.method === 'Network.responseReceived' && x.params.response.status >= 400) {
      failures.push(`HTTP ${x.params.response.status} ${x.params.response.url}`);
    }
  });

  await send('Page.navigate', { url: APP });
  await sleep(4000);

  console.log('=== boot text ===');
  console.log(await ev(`document.body.innerText.slice(0,600)`));

  console.log('\n=== what does app.js think the routes are? ===');
  console.log(await ev(`(()=>{
    const nav = [...document.querySelectorAll('nav a, [data-route], .nav a, aside a')].map(a=>a.getAttribute('href')||a.dataset.route);
    return JSON.stringify(nav);
  })()`));

  console.log('\n=== sign in through the form ===');
  await ev(`(()=>{
    const f = document.querySelector('form');
    if (!f) return 'no form';
    const set = (el,v)=>{ el.value=v; el.dispatchEvent(new Event('input',{bubbles:true})); };
    const ins = [...f.querySelectorAll('input')];
    if (ins[0]) set(ins[0], 'aarav@shop.test');
    if (ins[1]) set(ins[1], 'Passw0rd!');
    const btn = f.querySelector('button[type=submit],button');
    if (btn) btn.click();
    return 'submitted with ' + ins.length + ' fields';
  })()`);
  await sleep(3500);

  console.log('\n=== after sign-in: visible text ===');
  console.log(await ev(`document.body.innerText.slice(0,1200)`));

  console.log('\n=== nav links present now ===');
  console.log(await ev(`JSON.stringify([...document.querySelectorAll('a')].map(a=>a.getAttribute('href')).filter(Boolean))`));

  console.log('\n=== now walk each route by hash ===');
  const routes = ['#/catalog', '#/orders', '#/cart', '#/inventory', '#/payments', '#/audit', '#/users', '#/reconciliation', '#/returns', '#/shipments'];
  for (const r of routes) {
    console_.length = 0;
    await ev(`location.hash = ${JSON.stringify(r)}`);
    await sleep(1400);
    const body = await ev(`document.body.innerText.replace(/\\s+/g,' ').slice(0,220)`);
    console.log(`\n  ${r}`);
    console.log(`    text: ${body}`);
    if (console_.length) console.log(`    console: ${console_.join(' | ').slice(0,400)}`);
  }

  console.log('\n=== ALL console messages across the walk ===');
  console.log(console_.slice(0, 40).join('\n') || '  (none)');

  console.log('\n=== network failures ===');
  console.log(failures.length ? [...new Set(failures)].join('\n') : '  (none)');

  ws.close();
} catch (err) {
  console.log(`DIAGNOSTIC FAILED: ${err.message}`);
} finally {
  try { proc.kill(); } catch { /* already gone */ }
  process.exit(0);
}
// Verify the router fix end to end: sign in, walk every route in ROUTES, and
// confirm each one renders its own screen instead of the dashboard. Also checks
// that role gating hides what a customer must not see, and that a parametrised
// route (/orders/1) opens the detail view.
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const APP = process.env.APP ?? 'http://127.0.0.1:3010';
const PORT = Number(process.env.CDP_PORT ?? 9334);
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const proc = spawn(EDGE, [
  `--user-data-dir=C:\\Users\\sarth\\shop-hub\\.shot-diag2`,
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`, '--window-size=1500,1000', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function session(email, password) {
  let list = null;
  for (let i = 0; i < 40 && !list; i += 1) {
    await sleep(500);
    try { list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { /* not up */ }
  }
  if (!list) throw new Error('browser never came up');
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  let n = 0; const m = new Map();
  const noise = [];
  ws.addEventListener('message', (e) => {
    const x = JSON.parse(e.data);
    if (x.id && m.has(x.id)) { const y = m.get(x.id); m.delete(x.id); x.error ? y.rej(new Error(x.error.message)) : y.res(x.result); return; }
    if (x.method === 'Runtime.consoleAPICalled' && x.params.type === 'error') {
      noise.push(x.params.args.map((a) => a.value ?? a.description).join(' '));
    }
    if (x.method === 'Runtime.exceptionThrown') noise.push(`EXC ${x.params.exceptionDetails.exception?.description ?? ''}`);
  });
  const send = (method, params = {}) => { const id = ++n; return new Promise((res, rej) => { m.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); }); };
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result.value;
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: APP });
  await sleep(3500);

  await ev(`(()=>{
    const f = document.querySelector('form');
    const set=(el,v)=>{el.value=v;el.dispatchEvent(new Event('input',{bubbles:true}));};
    const ins=[...f.querySelectorAll('input')];
    set(ins[0], ${JSON.stringify(email)});
    set(ins[1], ${JSON.stringify(password)});
    f.querySelector('button').click();
    return 'ok';
  })()`);
  await sleep(3500);

  return { ev, noise, ws, close: () => ws.close() };
}

try {
  // ---- customer: the routes a shopper should get, and the ones they must not
  const s = await session('aarav@shop.test', 'Passw0rd!');
  const { ev, noise, ws, close } = s;

  console.log('=== customer: visible nav ===');
  console.log(' ', await ev(`JSON.stringify([...document.querySelectorAll('nav a')].map(a=>a.getAttribute('href')))`));

  console.log('\n=== customer: walk every route ===');
  const ALL = ['/', '/catalog', '/cart', '/orders', '/returns', '/inventory', '/products', '/shipments', '/payments', '/users'];
  // What a customer is entitled to see, mirroring the roles column in ROUTES.
  const ALLOWED_FOR_CUSTOMER = ['/catalog', '/cart', '/orders', '/returns'];
  let pass = 0; let fail = 0;
  for (const r of ALL) {
    noise.length = 0;
    await ev(`location.hash = ${JSON.stringify('#' + r)}`);
    await sleep(1500);
    const info = JSON.parse(await ev(`(()=>{
      const main = document.querySelector('main') || document.body;
      const t = main.innerText.replace(/\\s+/g,' ').trim();
      const h = [...document.querySelectorAll('main h1,main h2,main .screen-title')].map(e=>e.innerText.trim())[0] || '';
      const banner = document.querySelector('.banner-error');
      return JSON.stringify({
        head: t.slice(0,110),
        title: h,
        error: banner ? banner.innerText.slice(0,90) : null,
        rows: document.querySelectorAll('main table tbody tr').length,
        cards: document.querySelectorAll('main .card').length,
      });
    })()`));
    // Matched against the screen's own text. Deliberately not "Signed in as",
    // because the gate message itself says "you are signed in as customer" and
    // that made every gated route look like the dashboard.
    const isDash = /ORDERS PLACED|LIFETIME SPEND|Recent orders/i.test(info.head);
    // Three legitimate outcomes: the dashboard for "/", a gated screen for a
    // role the account does not hold, or the route's own screen. Anything else
    // is the bug this test exists to catch - every route rendering "/".
    const allowedHere = ALLOWED_FOR_CUSTOMER.includes(r);
    let verdict; let why;
    if (r === '/') {
      verdict = isDash; why = 'dashboard expected';
    } else if (!allowedHere) {
      verdict = !isDash && !!info.error && !info.rows;
      why = `should be gated, got ${info.error ? 'a gate message' : 'rows=' + info.rows}`;
    } else {
      verdict = !isDash && !info.error;
      why = 'own screen expected';
    }
    const ok = verdict && !noise.length;
    if (ok) pass += 1; else fail += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  #${r.padEnd(11)} title=${JSON.stringify(info.title).padEnd(16)} rows=${String(info.rows).padEnd(3)} cards=${String(info.cards).padEnd(3)} ${noise.length ? 'console=' + noise.join('|') : ''}${info.error ? ' banner=' + info.error : ''}`);
    if (!ok && !isDash) console.log(`        text: ${info.head}`);
  }

  console.log('\n=== customer: parametrised route ===');
  await ev(`location.hash = '#/orders/1'`);
  await sleep(1600);
  console.log('  #/orders/1 ->', await ev(`document.querySelector('main').innerText.replace(/\\s+/g,' ').slice(0,240)`));

  console.log('\n=== customer: a staff route by hand -> should 403 with a readable message ===');
  await ev(`location.hash = '#/inventory'`);
  await sleep(1600);
  console.log('  ', await ev(`(document.querySelector('.banner-error')?.innerText) || document.querySelector('main').innerText.replace(/\\s+/g,' ').slice(0,160)`));

  console.log(`\ncustomer walk: ${pass} pass, ${fail} fail`);
  close();

  // ---- admin: the routes a customer could not see
  const s2 = await session('admin@shop.test', 'Passw0rd!');
  console.log('\n=== admin: visible nav ===');
  console.log(' ', await s2.ev(`JSON.stringify([...document.querySelectorAll('nav a')].map(a=>a.getAttribute('href')))`));

  console.log('\n=== admin: the staff routes ===');
  for (const r of ['/inventory', '/payments', '/users', '/audit']) {
    await s2.ev(`location.hash = ${JSON.stringify('#' + r)}`);
    await sleep(1600);
    const t = await s2.ev(`(()=>{const m=document.querySelector('main');const b=document.querySelector('.banner-error');return JSON.stringify({head:m.innerText.replace(/\\s+/g,' ').slice(0,130),error:b?b.innerText.slice(0,80):null,rows:m.querySelectorAll('table tbody tr').length});})()`);
    console.log(`  #${r.padEnd(11)} ${t}`);
  }
  s2.close();

  fs.writeFileSync('C:\\Users\\sarth\\shop-hub\\wd2.txt', 'router walk complete\n', 'utf8');
} catch (err) {
  console.log(`FAILED: ${err.stack ?? err.message}`);
} finally {
  try { proc.kill(); } catch { /* gone */ }
  process.exit(0);
}
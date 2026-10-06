// ShopHub - screenshot capture.
//
// Drives a real Edge over the Chrome DevTools Protocol: signs in through the
// actual sign-in form, clicks through the actual console, and captures what the
// browser actually painted. Nothing here redraws or simulates the UI.
//
//   node scripts/capture-shots.mjs            # everything
//   node scripts/capture-shots.mjs console    # only shots whose name matches
//
// Requires the app to be running (see README) and Edge to be installed.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];
const EDGE = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!EDGE) {
  console.error('No Chromium browser found. Edit EDGE_CANDIDATES to point at one.');
  process.exit(1);
}

const APP = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const REPO = process.env.REPO_URL ?? 'https://github.com/nglfrsarthak/shop-hub';
const OUT = path.resolve(process.env.SHOT_DIR ?? 'docs/img');
const PROFILE = path.join(process.env.TEMP ?? '.', 'shophub-shot-profile');
const PORT = Number(process.env.CDP_PORT ?? 9333);
const WIDTH = 1440;
const HEIGHT = 900;
const SCALE = 2;
const PW = 'Passw0rd!';

fs.mkdirSync(OUT, { recursive: true });
const filter = process.argv[2] ?? '';

// --------------------------------------------------------------- CDP plumbing
class Cdp {
  #ws; #next = 0; #pending = new Map(); #listeners = new Map();

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && this.#pending.has(msg.id)) {
        const { resolve, reject } = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      for (const fn of this.#listeners.get(msg.method) ?? []) fn(msg.params);
    });
  }

  send(method, params = {}) {
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    const list = this.#listeners.get(method) ?? [];
    list.push(fn);
    this.#listeners.set(method, list);
  }

  once(method) {
    return new Promise((resolve) => {
      const fn = (params) => {
        this.#listeners.set(method, (this.#listeners.get(method) ?? []).filter((f) => f !== fn));
        resolve(params);
      };
      this.on(method, fn);
    });
  }

  close() { this.#ws.close(); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`gave up waiting for ${url}`);
}

const browser = spawn(EDGE, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-background-networking',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  `--window-size=${WIDTH},${HEIGHT}`,
  'about:blank',
], { stdio: 'ignore' });

let cdp;
const captured = [];

// If a step wedges, fail loudly instead of hanging: these runs are unattended.
const watchdog = setTimeout(() => {
  console.error('\ncapture timed out after 5 minutes');
  process.exit(9);
}, 5 * 60 * 1000);

try {
  await httpJson(`http://127.0.0.1:${PORT}/json/version`);

  // Reuse the tab the launcher opened rather than creating another one.
  const targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target to attach to');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('could not open the CDP socket')), { once: true });
  });
  cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE, mobile: false,
  });

  // ---------------------------------------------------------------- helpers
  async function evaluate(expression) {
    const r = await cdp.send('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      const msg = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
      throw new Error(`page threw: ${msg}`);
    }
    return r.result.value;
  }

  async function waitFor(expression, { timeout = 15000, label = expression } = {}) {
    const started = Date.now();
    for (;;) {
      let ok = false;
      try { ok = await evaluate(`Boolean(${expression})`); } catch { /* mid-navigation */ }
      if (ok) return true;
      if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
      await sleep(120);
    }
  }

  async function goto(url, readyExpression, { timeout = 15000 } = {}) {
    const loaded = cdp.once('Page.loadEventFired');
    await cdp.send('Page.navigate', { url });
    // The load event is not guaranteed for every navigation, so it is raced
    // against a deadline rather than awaited outright.
    await Promise.race([loaded, sleep(Math.max(15000, timeout))]);
    await waitFor(readyExpression, { label: `${url} to be ready`, timeout });
    await sleep(400); // let fonts and any final transition settle
  }

  async function shot(name, caption) {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(OUT, `${name}.png`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    const bytes = fs.statSync(file).size;
    captured.push({ name, file, caption, bytes });
    console.log(`  ${name}.png  ${(bytes / 1024).toFixed(0)} KB  ${caption}`);
  }

  // Sign in through the real form, so the screenshot shows what a user sees.
  async function signIn(email) {
    await goto(`${APP}/#/`, `document.querySelector('#auth-form') || document.querySelector('.shell')`);
    const alreadyIn = await evaluate(`Boolean(document.querySelector('.shell'))`);
    if (alreadyIn) return;
    await waitFor(`document.querySelector('#auth-form')`, { label: 'the sign-in form' });
    await evaluate(`(() => {
      const f = document.querySelector('#auth-form');
      f.email.value = ${JSON.stringify(email)};
      f.password.value = ${JSON.stringify(PW)};
      f.requestSubmit();
      return true;
    })()`);
    await waitFor(`document.querySelector('.shell')`, { label: `the shell after signing in as ${email}` });
    await sleep(300);
  }

  async function signOut() {
    const inShell = await evaluate(`Boolean(document.querySelector('#signout'))`);
    if (!inShell) return;
    await evaluate(`document.querySelector('#signout').click()`);
    await waitFor(`document.querySelector('#auth-form')`, { label: 'the sign-in form again' });
  }

  /** Move inside the SPA and wait for real table rows or content. */
  async function route(hash, ready = `document.querySelector('.content').textContent.length > 40`) {
    await evaluate(`location.hash = ${JSON.stringify(hash)}`);
    await waitFor(ready, { label: `route ${hash}` });
    await sleep(350);
  }

  const want = (group) => !filter || group.startsWith(filter);

  // ==================================================================== console
  console.log('\nconsole');

  if (want('console')) {
    await signOut();
    await goto(`${APP}/#/`, `document.querySelector('#auth-form')`);
    await shot('SS-10-signin-gate', 'Sign-in gate with the six demo roles and the refusal notice');

    await signIn('aarav@shop.test');
    await route('#/', `document.querySelectorAll('.card').length >= 4`);
    await shot('SS-11-customer-dashboard', 'Customer dashboard: orders placed, lifetime spend, cart, open returns');

    await route('#/catalog', `document.querySelectorAll('tbody tr').length >= 5`);
    await shot('SS-12-catalogue', 'Catalogue with search, category, sort and live availability per SKU');

    await route('#/catalog/aurora-headphones', `document.querySelectorAll('#product-pane tbody tr').length >= 2`);
    await shot('SS-13-product-variants', 'Product page: two SKUs, paise prices, availability computed not stored');

    await route('#/cart', `document.querySelector('.totals') || document.querySelector('.empty')`);
    await shot('SS-14-cart-totals', 'Cart with subtotal, 18% GST, shipping and grand total - all integer paise');

    await route('#/orders', `document.querySelectorAll('tbody tr').length >= 1`);
    await shot('SS-15-order-list', 'Order list scoped to the signed-in customer');

    // Follow the first order link the list actually rendered.
    await route('#/orders', `document.querySelectorAll('tbody tr').length >= 1`);
    const firstLink = await evaluate(`(() => {
      const a = document.querySelector('tbody tr a[href^="#/orders/"]');
      return a ? a.getAttribute('href') : null;
    })()`);
    if (firstLink) {
      await route(firstLink.replace('#', ''), `document.querySelector('#order-pane h2')`);
      await shot('SS-16-order-detail', 'Order detail: snapshotted lines, totals, legal next states, role-scoped actions');
    }

    // The access-control evidence: a customer typing a staff route.
    await route('#/inventory', `document.querySelector('.banner-error')`);
    await shot('SS-17-customer-403', 'A customer navigating to the inventory route and being refused by the API');

    await signOut();
    await signIn('vikram@shop.test');
    await route('#/', `document.querySelectorAll('.card').length >= 4`);
    await shot('SS-18-warehouse-dashboard', 'Warehouse dashboard: on hand, reserved, below reorder point, packed orders');

    await route('#/inventory', `document.querySelectorAll('tbody tr').length >= 8`);
    await shot('SS-19-inventory-low-stock', 'Stock levels with the low-stock report and on_hand - reserved as availability');

    await route('#/shipments', `document.querySelectorAll('tbody tr').length >= 1`);
    await shot('SS-20-dispatch', 'Dispatch queue: ready-to-dispatch orders and per-shipment next tracking events');

    await signOut();
    await signIn('anil@shop.test');
    await route('#/payments', `document.querySelectorAll('tbody tr').length >= 1`);
    await shot('SS-21-reconciliation', 'Finance: gross captured, refunded, net settled, and the identity the API asserts');

    await signOut();
    await signIn('neha@shop.test');
    await route('#/returns', `document.querySelector('table') || document.querySelector('.empty')`);
    await shot('SS-22-returns-lifecycle', 'Returns board with the legal next state for each return');

    await signOut();
    await signIn('admin@shop.test');
    await route('#/users', `document.querySelectorAll('tbody tr').length >= 8`);
    await shot('SS-23-users-and-audit', 'Admin: provisioned staff accounts and the append-only audit ledger');
  }

  // ==================================================================== github
  console.log('\ngithub');

  if (want('github')) {
    const repoShot = async (name, url, ready, caption, opts) => {
      try {
        await goto(url, ready, opts);
        await shot(name, caption);
      } catch (err) {
        console.error(`  ${name}: FAILED - ${err.message}`);
      }
    };

    await repoShot('SS-06-github-repo', `${REPO}`,
      `document.querySelector('#repository-container-header') || document.querySelector('main')`,
      'The pushed repository: README rendered, 18 tables and 51 endpoints stated up front');

    await repoShot('SS-07-github-history', `${REPO}/commits/main`,
      `document.body.innerText.includes('Commits on') || document.querySelectorAll('.Box-row').length >= 1`,
      'One epic or fix per commit, messages that say why');

    await repoShot('SS-08-github-diff-oversell', `${REPO}/commit/45c3d7b1b56afdb7a52f454adc4609b77ecbd64d`,
      `document.body.innerText.includes('Files changed') || document.body.innerText.includes('committed') || document.querySelectorAll('[data-testid="diff-lines"], .diff-table, .file').length >= 1`,
      'The no-oversell commit: the conditional UPDATE that closes the race',
      { timeout: 45000 });

    await repoShot('SS-09-github-source', `${REPO}/blob/main/app/src/routes/inventory.js`,
      `document.body.innerText.includes('reserveStock') || document.querySelector('[data-testid="blob-content"]')`,
      'inventory.js on GitHub - reserveStock, releaseStock, commitStock');
  }

  console.log(`\n${captured.length} screenshots written to ${OUT}\n`);
} finally {
  clearTimeout(watchdog);
  try { cdp?.close(); } catch { /* already gone */ }
  browser.kill();
  if (filter === '') {
    fs.writeFileSync(path.join(OUT, 'manifest.json'),
      JSON.stringify(captured.map(({ name, caption, bytes }) => ({ name, caption, bytes })), null, 2));
  }
  // The CDP socket keeps the event loop alive; leave deliberately.
  process.exit(0);
}
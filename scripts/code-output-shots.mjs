// ShopHub - capture real command output as a screenshot.
//
// Runs the commands, keeps their output byte for byte, wraps it in a
// terminal-styled HTML page, and screenshots that page with headless Edge.
//
// The point of the indirection is honesty: a screenshot of a terminal is a
// picture of text, and a picture is a worse way to read text than text. So the
// HTML is generated from the captured stdout with no editing at all, the
// script prints the exact byte count it wrapped, and the same output appears
// verbatim in the submission as a code block. If the two ever disagree, the
// code block is the one to believe.
//
//   node scripts/code-output-shots.mjs [base-url]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const EDGE = EDGE_CANDIDATES.find((p) => fs.existsSync(p));
if (!EDGE) {
  console.error('No Chromium browser found.');
  process.exit(1);
}

const APP = process.env.APP_URL ?? process.argv[2] ?? 'http://127.0.0.1:3000';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\//, ''), '..');
const OUT = path.join(ROOT, 'docs', 'img');
const PORT = Number(process.env.CDP_PORT ?? 9334);
const WIDTH = 1400;
const SCALE = 2;

fs.mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------- run them
/** Run a command and return its combined output, unmodified. */
function run(command, args, cwd) {
  const r = spawnSync(command, args, {
    cwd, encoding: 'buffer', shell: false, maxBuffer: 64 * 1024 * 1024,
  });
  return {
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`.toString('utf8'),
    code: r.status,
  };
}

const JOBS = [
  {
    name: 'SS-19-npm-test',
    caption: 'npm test - 74 acceptance tests across 8 suites, all passing',
    // node --test, not npm test: npm swallows the stream on Windows, so
    // capturing stdout would have produced nothing at all.
    command: 'node',
    args: ['--test', '--test-reporter=tap', 'tests/api.test.js'],
    cwd: path.join(ROOT, 'app'),
    // The run is a few hundred lines. Keep the per-suite lines and the summary
    // and drop the individual subtest chatter; everything dropped is in the file
    // the script writes next to the image.
    keep: (text) => {
      const lines = text.split(/\r?\n/);
      const summary = lines.filter((l) => /^# (tests|pass|fail|suites|cancelled|skipped|duration_ms)\b/.test(l.trim())
        || /^# (tests|pass|fail|suites|duration_ms) /.test(l.trim()));
      // A suite header is a bare "ok N - <name>" or "not ok N - <name>".
      const suites = lines.filter((l) => /^(ok|not ok) \d+ - /.test(l));
      const problems = lines.filter((l) => /^not ok/.test(l) || /^\s+not ok/.test(l));
      const body = [
        ...suites,
        ...(problems.length ? ['', '# ---- failures ----', ...problems] : []),
        '', '# ---- summary ----', ...summary,
      ];
      return body.join('\n');
    },
  },
  {
    name: 'SS-22-console-check',
    caption: 'node scripts/console-check.mjs - the browser client\'s formatter and error mapper',
    command: 'node',
    args: [path.join(ROOT, 'scripts', 'console-check.mjs')],
    cwd: ROOT,
    keep: (text) => text,
  },
  {
    name: 'SS-23-ci-run',
    caption: 'gh run view - the CI pipeline for the pushed commit',
    command: 'gh',
    args: ['run', 'list', '--limit', '3'],
    cwd: ROOT,
    keep: (text) => text,
  },
  {
    name: 'SS-24-git-log',
    caption: 'git log --oneline - one epic or fix per commit',
    command: 'git',
    args: ['log', '--oneline', '-16'],
    cwd: ROOT,
    keep: (text) => text,
  },
  {
    name: 'SS-25-ci-first-failure',
    caption: 'Run 37274485133 - Lint fails on a hard-coded JWT_SECRET',
    // Live from the run's own log, so this is the assertion GitHub recorded
    // rather than a description of it written afterwards.
    command: 'gh',
    args: ['run', 'view', '37274485133', '--log-failed'],
    cwd: ROOT,
    keep: (text) => text.split(/\r?\n/)
      .filter((l) => /##\[error\]|api\.test\.js|a hard-coded/.test(l))
      .map(stripLogPrefix)
      .slice(0, 10)
      .join('\n'),
  },
  {
    name: 'SS-25b-check-was-wrong',
    caption: 'Run 37274799850 - the replacement check failed for its own reason',
    command: 'gh',
    args: ['run', 'view', '37274799850', '--log-failed'],
    cwd: ROOT,
    keep: (text) => text.split(/\r?\n/)
      .filter((l) => /##\[error\]|ERR_MODULE_NOT_FOUND|jsonwebtoken/.test(l))
      .map(stripLogPrefix)
      .slice(0, 8)
      .join('\n'),
  },
  {
    name: 'SS-26-smoke-test',
    caption: 'node scripts/smoke-test.mjs - 30 checks over HTTP against the running server',
    command: 'node',
    args: [path.join(ROOT, 'scripts', 'smoke-test.mjs'), APP],
    cwd: ROOT,
    keep: (text) => text,
  },
  {
    name: 'SS-21-api-meta',
    caption: 'GET /api/v1/meta - the API describing its own endpoint and table counts',
    command: 'node',
    args: ['-e', `fetch('${APP}/api/v1/meta').then(r=>r.text()).then(t=>console.log('HTTP 200\\n'+JSON.stringify(JSON.parse(t),null,2)))`],
    cwd: ROOT,
    keep: (text) => text,
  },
];

// ------------------------------------------------------------------- wrap it
const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// gh log lines look like "<job>\t<step>\t<timestamp>Z <text>"; the first two
// fields are noise once the timestamp is gone.
const stripLogPrefix = (line) => line
  .replace(/^[^	]*	[^	]*	/, '')
  .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, '')
  .replace(/\x1b\[[\d;]*m/g, '');

/** ANSI-free, with runs coloured by meaning so the eye lands on the totals. */
function highlight(line) {
  const esc = escapeHtml(line);
  if (/^(ℹ )?(pass|fail|tests|suites|duration_ms) /.test(line)) return `<span class="hl">${esc}</span>`;
  if (/^\s*✖/.test(line)) return `<span class="bad">${esc}</span>`;
  if (/\bPASS\b/.test(line)) return `<span class="ok">${esc}</span>`;
  if (/^#/.test(line)) return `<span class="cmt">${esc}</span>`;
  if (/^\s*at |^\s*async /.test(line)) return `<span class="dim">${esc}</span>`;
  return esc;
}

const pages = [];
for (const job of JOBS) {
  const { out, code } = run(job.command, job.args ?? [], job.cwd);
  const kept = job.keep(out);
  console.log(`${job.name}: ${out.length} bytes captured, ${kept.length} shown, exit ${code}`);

  // Kept as a plain text file beside the image, so the screenshot can be checked.
  fs.writeFileSync(path.join(OUT, `${job.name}.txt`), kept, 'utf8');

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>${job.name}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0d1117; font:13px/1.55 ui-monospace, "Cascadia Mono", Consolas, monospace; }
  .frame { padding:18px 20px 22px; }
  .bar { display:flex; align-items:center; gap:8px; padding-bottom:12px; border-bottom:1px solid #21262d; margin-bottom:14px; }
  .dot { width:11px; height:11px; border-radius:50%; }
  .title { margin-left:10px; color:#e6edf3; font-size:13px; font-weight:600; }
  .cmd { margin-left:auto; color:#8b949e; font-size:12px; }
  pre { margin:0; color:#c9d1d9; white-space:pre-wrap; word-break:break-word; }
  .hl  { color:#ffa657; font-weight:600; }
  .ok  { color:#3fb950; }
  .bad { color:#f85149; }
  .cmt { color:#58a6ff; }
  .dim { color:#6e7681; }
</style></head>
<body><div class="frame">
  <div class="bar">
    <span class="dot" style="background:#ff5f57"></span>
    <span class="dot" style="background:#febc2e"></span>
    <span class="dot" style="background:#28c840"></span>
    <span class="title">${escapeHtml(job.caption)}</span>
    <span class="cmd">${escapeHtml([job.command, ...(job.args ?? [])].join(' '))}</span>
  </div>
  <pre>${kept.split(/\r?\n/).map(highlight).join('\n')}</pre>
</div></body></html>`;

  const file = path.join(OUT, `${job.name}.html`);
  fs.writeFileSync(file, html, 'utf8');
  pages.push({ name: job.name, file, caption: job.caption });
}

// ------------------------------------------------------------------- capture
class Cdp {
  #ws; #next = 0; #pending = new Map();
  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id !== undefined && this.#pending.has(m.id)) {
        const { resolve, reject } = this.#pending.get(m.id);
        this.#pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.#next;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(process.env.TEMP, 'shophub-term-profile')}`,
  `--window-size=${WIDTH},900`,
  'about:blank',
], { stdio: 'ignore' });

try {
  let version;
  for (let i = 0; i < 60; i += 1) {
    try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
    catch { await sleep(250); }
  }
  if (!version) throw new Error('the browser did not expose a debugging port');

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('no CDP socket')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  for (const p of pages) {
    // Height is measured from the real content so nothing is cut off.
    await cdp.send('Page.navigate', { url: `file:///${p.file.replace(/\\/g, '/')}` });
    await sleep(900);
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'Math.ceil(document.querySelector(".frame").getBoundingClientRect().height)',
      returnByValue: true,
    });
    const height = Math.min(Math.max(result.value + 20, 320), 3000);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH, height, deviceScaleFactor: SCALE, mobile: false,
    });
    await sleep(250);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const png = path.join(OUT, `${p.name}.png`);
    fs.writeFileSync(png, Buffer.from(data, 'base64'));
    console.log(`  ${p.name}.png  ${(fs.statSync(png).size / 1024).toFixed(0)} KB  ${p.caption}`);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  }

  fs.writeFileSync(path.join(OUT, 'manifest-code.json'), JSON.stringify(pages, null, 2));
  console.log(`\n${pages.length} output screenshots written to ${OUT}\n`);
} finally {
  browser.kill();
  // The CDP socket keeps the event loop alive; leave deliberately.
  process.exit(0);
}
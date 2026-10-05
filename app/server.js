// ShopHub API entrypoint
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { migrate, db } from './src/db.js';
import { maybeSeed, DEMO_PASSWORD } from './src/seed.js';
import { requireAuth, ROLES } from './src/auth.js';

import identityRoutes from './src/routes/identity.js';
import catalogRoutes from './src/routes/catalog.js';
import inventoryRoutes from './src/routes/inventory.js';
import orderRoutes from './src/routes/orders.js';
import paymentRoutes from './src/routes/payments.js';
import fulfilmentRoutes from './src/routes/fulfilment.js';
import insightRoutes from './src/routes/insights.js';

const PORT = Number(process.env.PORT || 3000);
const startedAt = Date.now();

migrate();
const seedResult = maybeSeed();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// Structured request log to stdout, one JSON object per line.
const LOG_REQUESTS = process.env.NODE_ENV !== 'test';
app.use((req, res, next) => {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    if (!LOG_REQUESTS) return;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      msg: 'request',
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration_ms: Number(ms.toFixed(2)),
    }));
  });
  next();
});

app.get('/healthz', (_req, res) =>
  res.json({ status: 'ok', service: 'shop-hub', uptime_s: Math.round((Date.now() - startedAt) / 1000) }));

app.get('/readyz', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    return res.json({ status: 'ready', db: 'ok' });
  } catch (err) {
    return res.status(503).json({ status: 'not_ready', db: err.message });
  }
});

/** Machine-readable index of the API - also what the console read at boot. */
app.get('/api/v1/meta', (_req, res) => {
  const tables = db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().n;

  // Counted from the routers themselves rather than app._router, which only
  // knows the mounts and not the routes behind them.
  const ROUTERS = [identityRoutes, catalogRoutes, inventoryRoutes, orderRoutes,
    paymentRoutes, fulfilmentRoutes, insightRoutes];
  const countRoutes = (router) => router.stack
    .filter((l) => l.route)
    .reduce((s, l) => s + Object.keys(l.route.methods).length, 0);
  const endpoints = ROUTERS.reduce((s, r) => s + countRoutes(r), 0) + 3; // + healthz, readyz, meta

  res.json({
    service: 'shop-hub',
    version: '1.0.0',
    currency: 'INR',
    money_unit: 'paise (integer)',
    roles: ROLES,
    endpoints,
    tables,
  });
});

// The console is served from the same origin in development, so no CORS dance.
app.use('/api/v1', identityRoutes);
app.use('/api/v1', catalogRoutes);
app.use('/api/v1', inventoryRoutes);
app.use('/api/v1', orderRoutes);
app.use('/api/v1', paymentRoutes);
app.use('/api/v1', fulfilmentRoutes);
app.use('/api/v1', insightRoutes);

app.use('/api/v1', (_req, res) => res.status(404).json({ error: 'unknown endpoint' }));

// The console is plain static files, served from the same origin as the API so
// there is no CORS configuration and no second process to run in development.
const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');

app.get('/', (_req, res) => res.sendFile(path.join(WEB_DIR, 'index.html')));
app.use(express.static(WEB_DIR, { index: false, maxAge: 0 }));

app.use((err, _req, res, _next) => {
  const status = err.status ?? 500;
  console.error(JSON.stringify({
    ts: new Date().toISOString(), level: 'error', msg: 'unhandled', error: err.message,
  }));
  res.status(status).json({ error: status === 500 ? 'internal_error' : err.message });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`ShopHub listening on http://127.0.0.1:${PORT}`);
    console.log(`  console  http://127.0.0.1:${PORT}/`);
    console.log(`  api      http://127.0.0.1:${PORT}/api/v1/meta`);
    if (seedResult.seeded) console.log(`  demo     password for every account: ${DEMO_PASSWORD}`);
  });
}

export default app;
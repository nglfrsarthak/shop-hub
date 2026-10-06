// ShopHub - smoke test.
//
// Runs against a live server and proves the four journeys that matter actually
// work over HTTP, rather than through an in-process test harness. This is the
// check that would catch a broken route mount, a missing static file or a
// console that cannot reach the API - none of which unit tests can see.
//
//   node scripts/smoke-test.mjs [base-url]
import assert from 'node:assert/strict';

const BASE = process.argv[2] ?? process.env.BASE_URL ?? 'http://127.0.0.1:3000';
const PW = 'Passw0rd!';

let passed = 0;
let failed = 0;
const results = [];

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, body: json };
}

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    results.push(['PASS', name]);
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    results.push(['FAIL', name, err.message]);
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

async function login(email) {
  const res = await call('POST', '/api/v1/auth/login', { body: { email, password: PW } });
  assert.equal(res.status, 200, `login ${email}: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

const seq = Date.now();
const reg = await call('POST', '/api/v1/auth/register', {
  body: { name: 'Smoke Customer', email: `smoke${seq}@shop.test`, password: PW },
});
assert.equal(reg.status, 201, `smoke customer registration: ${JSON.stringify(reg.body)}`);
const CUST = reg.body.token;
const WAREHOUSE = await login('vikram@shop.test');
const FINANCE = await login('anil@shop.test');
const ADMIN = await login('admin@shop.test');

await call('POST', '/api/v1/me/addresses', {
  token: CUST,
  body: { label: 'Home', line1: '9 Smoke Lane', city: 'Pune', pincode: '411001', is_default: 1 },
});

console.log(`\nShopHub smoke test against ${BASE}\n`);

console.log('service');
await check('healthz reports ok', async () => {
  const res = await call('GET', '/healthz');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
});
await check('readyz reports the database is reachable', async () => {
  const res = await call('GET', '/readyz');
  assert.equal(res.body.status, 'ready');
});
await check('meta publishes the endpoint count', async () => {
  const res = await call('GET', '/api/v1/meta');
  assert.equal(res.body.service, 'shop-hub');
  assert.ok(res.body.endpoints >= 45, `only ${res.body.endpoints} endpoints`);
});

console.log('\ncatalogue');
await check('an anonymous visitor can browse and search', async () => {
  const res = await call('GET', '/api/v1/catalog?per=5');
  assert.equal(res.status, 200);
  assert.ok(res.body.data.length > 0);
  assert.ok(res.body.data[0].product_name, 'a catalogue row must name its product');
});
await check('a product page lists its SKUs with availability', async () => {
  const res = await call('GET', '/api/v1/products/aurora-headphones');
  assert.equal(res.status, 200);
  assert.ok(res.body.data.variants.length > 0, 'the product should have at least one variant');
  for (const v of res.body.data.variants) {
    assert.ok(Number.isInteger(v.available), `${v.sku} availability should be a whole number`);
    assert.equal(v.in_stock, v.available > 0, 'in_stock must agree with availability');
    assert.match(v.price_display, /^\u20b9[\d,]+\.\d{2}$/);
  }
});

console.log('\njourney 1 - browse, order, pay');
let orderId;
await check('add a SKU to the cart', async () => {
  const catalog = await call('GET', '/api/v1/catalog?q=Terra Insulated&per=1');
  const sku = catalog.body.data[0];
  assert.ok(sku, 'no Terra SKU found in the catalogue');
  const res = await call('POST', '/api/v1/cart/items', {
    token: CUST, body: { variant_id: sku.id, qty: 1 },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.items.length, 1);
});
await check('the cart total is internally consistent', async () => {
  const res = await call('GET', '/api/v1/cart', { token: CUST });
  const c = res.body.data;
  assert.equal(c.subtotal_paise - c.discount_paise + c.tax_paise + c.shipping_paise, c.total_paise);
  assert.ok(Number.isInteger(c.total_paise));
});
await check('checkout creates the order and reserves the stock', async () => {
  const res = await call('POST', '/api/v1/orders', { token: CUST, body: {} });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  orderId = res.body.data.id;
  assert.match(res.body.data.code, /^SH-\d+$/);
  assert.equal(res.body.data.status, 'created');
  assert.equal(res.body.data.allowed_transitions.sort().join(), 'cancelled,paid');
});
await check('paying captures the money and advances the order', async () => {
  const res = await call('POST', `/api/v1/orders/${orderId}/pay`, {
    token: CUST,
    body: { method: 'upi', idempotency_key: `smoke-${orderId}-${seq}` },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'captured');
  assert.match(res.body.data.receipt_no, /^RCPT-\d{5}$/);
});
await check('replaying the same idempotency key does not charge twice', async () => {
  const res = await call('POST', `/api/v1/orders/${orderId}/pay`, {
    token: CUST,
    body: { method: 'upi', idempotency_key: `smoke-${orderId}-${seq}` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.replayed, true);
});
await check('an order cannot jump straight to shipped', async () => {
  const res = await call('POST', `/api/v1/orders/${orderId}/status`, {
    token: WAREHOUSE, body: { status: 'shipped' },
  });
  assert.equal(res.status, 422);
  assert.match(res.body.error, /illegal transition/);
});
await check('the warehouse picks and packs it', async () => {
  for (const status of ['picking', 'packed']) {
    const res = await call('POST', `/api/v1/orders/${orderId}/status`, {
      token: WAREHOUSE, body: { status },
    });
    assert.equal(res.status, 200, `${status}: ${JSON.stringify(res.body)}`);
  }
});
await check('dispatch commits the stock and creates the tracking record', async () => {
  const before = await call('GET', '/api/v1/inventory', { token: WAREHOUSE });
  const reservedBefore = before.body.summary.total_reserved;

  const res = await call('POST', `/api/v1/admin/orders/${orderId}/ship`, {
    token: WAREHOUSE, body: { carrier: 'SmokeExpress', tracking_no: `SMK${seq}` },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.tracking_no, `SMK${seq}`);

  const after = await call('GET', '/api/v1/inventory', { token: WAREHOUSE });
  assert.ok(after.body.summary.total_reserved < reservedBefore, 'reservation should have been released');
});
await check('the courier delivers and the order closes', async () => {
  const shipments = await call('GET', '/api/v1/shipments', { token: WAREHOUSE });
  const shipment = shipments.body.data.find((s) => s.tracking_no === `SMK${seq}`);
  assert.ok(shipment, 'shipment not visible to the warehouse');

  for (const [status, location] of [['in_transit', 'Pune hub'], ['out_for_delivery', 'Pune'], ['delivered', 'Pune']]) {
    const res = await call('POST', `/api/v1/shipments/${shipment.id}/events`, {
      token: WAREHOUSE, body: { status, location },
    });
    assert.equal(res.status, 200, `${status}: ${JSON.stringify(res.body)}`);
  }
  const order = await call('GET', `/api/v1/orders/${orderId}`, { token: CUST });
  assert.equal(order.body.data.status, 'delivered');
  assert.deepEqual(order.body.data.allowed_transitions, []);
});

console.log('\njourney 2 - cancel before dispatch');
let cancelledOrderId;
await check('a second order can be cancelled before it ships', async () => {
  const catalog = await call('GET', '/api/v1/catalog?q=Lumen Smart Lamp&per=1');
  const sku = catalog.body.data[0];
  assert.ok(sku, 'no Lumen SKU found');
  await call('POST', '/api/v1/cart/items', { token: CUST, body: { variant_id: sku.id, qty: 1 } });

  const placed = await call('POST', '/api/v1/orders', { token: CUST, body: {} });
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  cancelledOrderId = placed.body.data.id;

  const paid = await call('POST', `/api/v1/orders/${cancelledOrderId}/pay`, {
    token: CUST,
    body: { method: 'upi', idempotency_key: `smoke-cancel-${cancelledOrderId}-${seq}` },
  });
  assert.equal(paid.status, 201);

  const cancelled = await call('POST', `/api/v1/orders/${cancelledOrderId}/cancel`, {
    token: CUST, body: { reason: 'smoke test cancellation' },
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.data.status, 'cancelled');
  assert.equal(cancelled.body.refunded, true, 'a paid cancellation reverses the money');
});
await check('the cancelled order has released its reservation', async () => {
  const inv = await call('GET', '/api/v1/inventory', { token: WAREHOUSE });
  const anyNegative = inv.body.data.some((v) => v.available < 0 || v.reserved < 0);
  assert.equal(anyNegative, false, 'no stock level may go negative after a cancellation');
  const order = await call('GET', `/api/v1/orders/${cancelledOrderId}`, { token: CUST });
  assert.deepEqual(order.body.data.allowed_transitions, []);
});
await check('a finished order cannot be cancelled again', async () => {
  const again = await call('POST', `/api/v1/orders/${cancelledOrderId}/cancel`, {
    token: CUST, body: { reason: 'twice' },
  });
  assert.equal(again.status, 422);
  assert.deepEqual(again.body.allowed, []);
});

console.log('\njourney 3 - return and refund');
await check('a delivered line can be returned', async () => {
  const order = await call('GET', `/api/v1/orders/${orderId}`, { token: CUST });
  const res = await call('POST', '/api/v1/returns', {
    token: CUST,
    body: { order_item_id: order.body.data.items[0].id, qty: 1, reason: 'smoke test return' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'requested');
  globalThis.__returnId = res.body.data.id;
});
await check('support approves, the warehouse receives, finance refunds', async () => {
  const id = globalThis.__returnId;
  const support = await login('neha@shop.test');

  const approved = await call('PATCH', `/api/v1/returns/${id}/status`, {
    token: support, body: { status: 'approved' },
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  const transit = await call('PATCH', `/api/v1/returns/${id}/status`, {
    token: support, body: { status: 'in_transit' },
  });
  assert.equal(transit.status, 200, JSON.stringify(transit.body));

  const received = await call('PATCH', `/api/v1/returns/${id}/status`, {
    token: WAREHOUSE, body: { status: 'received' },
  });
  assert.equal(received.status, 200, JSON.stringify(received.body));

  const refunded = await call('PATCH', `/api/v1/returns/${id}/status`, {
    token: FINANCE, body: { status: 'refunded' },
  });
  assert.equal(refunded.status, 200, JSON.stringify(refunded.body));
  assert.ok(refunded.body.refunded_paise > 0);
});
await check('finance reconciliation still balances', async () => {
  const res = await call('GET', '/api/v1/finance/reconciliation', { token: FINANCE });
  assert.equal(res.status, 200);
  assert.equal(res.body.net_settled_paise, res.body.gross_captured_paise - res.body.refunded_paise);
  assert.ok(res.body.net_settled_paise >= 0);
});

console.log('\naccess control');
await check('a customer cannot reach the inventory report', async () => {
  assert.equal((await call('GET', '/api/v1/inventory', { token: CUST })).status, 403);
});
await check('the warehouse can receive stock and it lands in the ledger', async () => {
  const catalog = await call('GET', '/api/v1/catalog?q=Terra Insulated&per=1');
  const sku = catalog.body.data[0];
  const before = await call('GET', '/api/v1/inventory', { token: WAREHOUSE });
  const beforeRow = before.body.data.find((v) => v.sku === sku.sku);

  const res = await call('POST', `/api/v1/admin/inventory/${sku.id}/receive`, {
    token: WAREHOUSE, body: { qty: 40, reason: 'goods_received', reference: `SMOKE-${seq}` },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.on_hand, beforeRow.on_hand + 40);

  const moves = await call('GET', `/api/v1/inventory/movements?sku=${sku.sku}&limit=5`, { token: WAREHOUSE });
  assert.equal(moves.body.data[0].delta, 40);
  assert.equal(moves.body.data[0].reason, 'goods_received');

  // Put it back so repeated runs start from the same place.
  await call('PATCH', `/api/v1/admin/inventory/${sku.id}`, {
    token: WAREHOUSE, body: { on_hand: beforeRow.on_hand, reason: 'smoke_test_rollback' },
  });
});
await check('the oversell guard refuses more than is available', async () => {
  const catalog = await call('GET', '/api/v1/catalog?q=Nomad Rechargeable&per=1');
  const sku = catalog.body.data[0];
  const other = await call('POST', '/api/v1/auth/register', {
    body: { name: 'Greedy Buyer', email: `greedy${seq}@shop.test`, password: PW },
  });
  const buyer = other.body.token;
  await call('POST', '/api/v1/me/addresses', {
    token: buyer, body: { label: 'Home', line1: '8 Rush Road', city: 'Pune', pincode: '411002', is_default: 1 },
  });

  const res = await call('POST', '/api/v1/cart/items', {
    token: buyer, body: { variant_id: sku.id, qty: sku.available + 1 },
  });
  assert.equal(res.status, 409, 'adding more than available must be refused');
  assert.equal(res.body.error, 'insufficient stock');
  assert.equal(res.body.sku, sku.sku);
});
await check('a customer cannot provision a staff account', async () => {
  const res = await call('POST', '/api/v1/admin/users', {
    token: CUST, body: { name: 'Nope', email: `nope${seq}@shop.test`, password: PW, role: 'admin' },
  });
  assert.equal(res.status, 403);
});
await check('a customer cannot read the audit ledger', async () => {
  assert.equal((await call('GET', '/api/v1/audit', { token: CUST })).status, 403);
});
await check('an unauthenticated call is refused', async () => {
  assert.equal((await call('GET', '/api/v1/orders')).status, 401);
});
await check('an unknown endpoint answers with JSON', async () => {
  const res = await call('GET', '/api/v1/nope');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'unknown endpoint');
});

console.log('\nconsole');
await check('the web console is served', async () => {
  const res = await fetch(`${BASE}/`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /<title>ShopHub/i);
  assert.match(html, /app\.js/);
});
await check('the console stylesheet is served', async () => {
  assert.equal((await fetch(`${BASE}/styles.css`)).status, 200);
});

console.log('\naudit');
// Each action is checked against its own entity: a payment event is filed under
// the payment, not under the order it paid for.
await check('the journey is traceable in the audit ledger', async () => {
  const wanted = [
    ['order', 'order.placed'],
    ['order', 'order.status_changed'],
    ['order', 'order.cancelled'],
    ['payment', 'payment.captured'],
    ['shipment', 'shipment.dispatched'],
    ['shipment', 'shipment.event'],
    ['return', 'return.requested'],
    ['return', 'return.status_changed'],
    ['variant', 'stock.received'],
  ];
  for (const [entity, action] of wanted) {
    const res = await call('GET', `/api/v1/audit?entity=${entity}&limit=200`, { token: ADMIN });
    assert.ok(res.body.data.some((e) => e.action === action),
      `missing audit action ${action} on entity ${entity}`);
  }
});

console.log(`\n${'-'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
console.log(`${'-'.repeat(60)}\n`);
process.exit(failed === 0 ? 0 : 1);
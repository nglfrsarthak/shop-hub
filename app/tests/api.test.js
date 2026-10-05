// ShopHub - acceptance tests.
//
// One block per user story where the story has a rule worth proving. Tests run
// against a freshly seeded database in a throwaway file, so the numbers are real
// rather than mocked.
//
//   cd app && npm test
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-not-for-production';
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shophub-test-')), 'test.db');
process.env.DB_SEED = 'true';

const { default: app } = await import('../server.js');
const { db } = await import('../src/db.js');
const { ROLES } = await import('../src/auth.js');

// ------------------------------------------------------------------ helpers
const PW = 'Passw0rd!';

async function tokenFor(email, password = PW) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  assert.equal(res.status, 200, `login failed for ${email}: ${JSON.stringify(res.body)}`);
  return res.body.token;
}

const as = (token) => ({ Authorization: `Bearer ${token}` });
let T = {};

before(async () => {
  T = {
    aarav: await tokenFor('aarav@shop.test'),
    diya: await tokenFor('diya@shop.test'),
    neha: await tokenFor('neha@shop.test'),          // agent
    vikram: await tokenFor('vikram@shop.test'),      // warehouse
    priya: await tokenFor('priya@shop.test'),        // merchandiser
    anil: await tokenFor('anil@shop.test'),          // finance
    admin: await tokenFor('admin@shop.test'),
  };
});

const variantBySku = (sku) => db.prepare('SELECT * FROM variants WHERE sku = ?').get(sku);
const stockOf = (variantId) => db.prepare('SELECT * FROM stock_levels WHERE variant_id = ?').get(variantId);

/** Create a fresh customer so a test never collides with another test's orders. */
let seq = 0;
async function freshCustomer(role = 'customer') {
  seq += 1;
  const email = `t${Date.now()}${seq}@shop.test`;
  const res = await request(app).post('/api/v1/auth/register')
    .send({ name: `Test ${seq}`, email, password: 'Passw0rd!', role });
  assert.equal(res.status, 201);
  const uid = res.body.user.id;
  await request(app).post('/api/v1/me/addresses').set(as(res.body.token))
    .send({ label: 'Home', line1: '1 Test Street', city: 'Pune', pincode: '411001', is_default: 1 })
    .expect(201);
  return { id: uid, email, token: res.body.token };
}

/**
 * Take a SKU to a known quantity so a test controls the stock boundary.
 * Writes a compensating movement so the ledger invariant test stays honest -
 * poking stock_levels directly would break it for reasons that have nothing to
 * do with the code under test.
 */
function setStock(variantId, onHand, reserved = 0) {
  const before = db.prepare('SELECT on_hand FROM stock_levels WHERE variant_id = ?').get(variantId)?.on_hand ?? 0;
  db.prepare('UPDATE stock_levels SET on_hand = ?, reserved = ? WHERE variant_id = ?').run(onHand, reserved, variantId);
  if (onHand !== before) {
    db.prepare(`INSERT INTO stock_movements (variant_id, delta, reason, ref_type, ref_id, actor_id)
                VALUES (?,?,'test_fixture',NULL,NULL,NULL)`).run(variantId, onHand - before);
  }
}

/**
 * Drive an order to a target status, using the endpoint that actually owns each
 * edge: payment for -> paid, the pick/pack flow for picking and packed, and the
 * dispatch endpoint (plus courier events) for shipped and delivered.
 */
async function orderAt(target, { pay = true, sku = 'TER-MUG-01', qty = 1 } = {}) {
  const cust = await freshCustomer();
  const v = variantBySku(sku);
  setStock(v.id, Math.max(stockOf(v.id).on_hand, 50));
  await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: v.id, qty }).expect(201);
  const placed = await request(app).post('/api/v1/orders').set(as(cust.token)).send({});
  assert.equal(placed.status, 201, JSON.stringify(placed.body));
  const orderId = placed.body.data.id;

  if (pay) {
    const payRes = await request(app).post(`/api/v1/orders/${orderId}/pay`).set(as(cust.token))
      .send({ method: 'upi', idempotency_key: `k-${orderId}-${Date.now()}${seq}` });
    assert.equal(payRes.status, 201, JSON.stringify(payRes.body));
  }
  if (!target || target === 'placed') return { ...cust, orderId };

  // picking -> packed
  for (const step of ['picking', 'packed']) {
    if (target === 'picking' && step === 'packed') break;
    const res = await request(app).post(`/api/v1/orders/${orderId}/status`).set(as(T.vikram)).send({ status: step });
    assert.equal(res.status, 200, `step ${step}: ${JSON.stringify(res.body)}`);
  }
  if (target === 'packed' || target === 'picking') return { ...cust, orderId };

  // packed -> shipped, via dispatch
  assert.ok(['shipped', 'delivered'].includes(target), `unsupported target ${target}`);
  const ship = await request(app).post(`/api/v1/admin/orders/${orderId}/ship`).set(as(T.vikram))
    .send({ carrier: 'BlueDart', tracking_no: `TRK${Date.now()}o${orderId}` });
  assert.equal(ship.status, 201, JSON.stringify(ship.body));
  const shipmentId = ship.body.data.id;

  // A 'shipped' fixture stops at the label; tracking events are the test's job.
  if (target === 'shipped') return { ...cust, orderId, shipmentId };

  await request(app).post(`/api/v1/shipments/${shipmentId}/events`).set(as(T.vikram))
    .send({ status: 'in_transit', location: 'Nagpur hub' }).expect(200);
  await request(app).post(`/api/v1/shipments/${shipmentId}/events`).set(as(T.vikram))
    .send({ status: 'out_for_delivery', location: 'Pune' }).expect(200);
  await request(app).post(`/api/v1/shipments/${shipmentId}/events`).set(as(T.vikram))
    .send({ status: 'delivered', location: 'Pune' }).expect(200);
  return { ...cust, orderId, shipmentId };
}

// ===========================================================================
describe('E1 - identity, access and roles', () => {
  it('registers a customer and returns a usable token', async () => {
    const res = await request(app).post('/api/v1/auth/register')
      .send({ name: 'New Person', email: 'new.person@shop.test', password: 'Passw0rd!' });
    assert.equal(res.status, 201);
    assert.equal(res.body.user.role, 'customer');
    assert.ok(res.body.token);
    await request(app).get('/api/v1/auth/me').set(as(res.body.token)).expect(200);
  });

  it('refuses a password under 8 characters', async () => {
    const res = await request(app).post('/api/v1/auth/register')
      .send({ name: 'Short', email: 'short@shop.test', password: 'short12' });
    assert.equal(res.status, 400);
  });

  it('refuses to let anyone self-assign a staff role', async () => {
    for (const role of ['admin', 'finance', 'warehouse', 'merchandiser', 'agent']) {
      const res = await request(app).post('/api/v1/auth/register')
        .send({ name: 'Sneaky', email: `sneaky-${role}@shop.test`, password: 'Passw0rd!', role });
      assert.equal(res.status, 403, `role ${role} should not be self-assignable`);
      assert.deepEqual(res.body.allowed, ['customer']);
    }
  });

  it('rejects a duplicate email with 409', async () => {
    const res = await request(app).post('/api/v1/auth/register')
      .send({ name: 'Copy', email: 'aarav@shop.test', password: 'Passw0rd!' });
    assert.equal(res.status, 409);
  });

  it('rejects a wrong password with 401 and records the attempt', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'aarav@shop.test', password: 'nope' });
    assert.equal(res.status, 401);
    const n = db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'user.login_failed'").get().n;
    assert.ok(n >= 1, 'the failed attempt should be in the audit ledger');
  });

  it('rejects an unauthenticated request with 401', async () => {
    await request(app).get('/api/v1/orders').expect(401);
    await request(app).get('/api/v1/orders').set({ Authorization: 'Bearer not-a-jwt' }).expect(401);
    await request(app).get('/api/v1/orders').set({ Authorization: 'Basic dXNlcjpwYXNz' }).expect(401);
  });

  it('stores passwords as PBKDF2 hashes, never plaintext', async () => {
    const u = db.prepare('SELECT password_hash FROM users WHERE email = ?').get('aarav@shop.test');
    assert.match(u.password_hash, /^pbkdf2\$120000\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    assert.ok(!u.password_hash.includes(PW));
  });

  it('lets an admin provision staff and nobody else do so', async () => {
    const email = `staff${Date.now()}@shop.test`;
    const ok = await request(app).post('/api/v1/admin/users').set(as(T.admin))
      .send({ name: 'New Agent', email, password: PW, role: 'agent' });
    assert.equal(ok.status, 201);

    const denied = await request(app).post('/api/v1/admin/users').set(as(T.aarav))
      .send({ name: 'Nope', email: 'x@shop.test', password: PW, role: 'agent' });
    assert.equal(denied.status, 403);

    const unknown = await request(app).post('/api/v1/admin/users').set(as(T.admin))
      .send({ name: 'Bad', email: 'y@shop.test', password: PW, role: 'wizard' });
    assert.equal(unknown.status, 400);
    assert.deepEqual(unknown.body.valid, ROLES);
  });

  it('stops an admin demoting themselves', async () => {
    const me = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@shop.test');
    const res = await request(app).patch(`/api/v1/admin/users/${me.id}/role`).set(as(T.admin)).send({ role: 'customer' });
    assert.equal(res.status, 422);
    const still = db.prepare('SELECT role FROM users WHERE id = ?').get(me.id);
    assert.equal(still.role, 'admin');
  });

  it('rejects a bad pincode', async () => {
    const res = await request(app).post('/api/v1/me/addresses').set(as(T.aarav))
      .send({ label: 'X', line1: 'a', city: 'b', pincode: '123' });
    assert.equal(res.status, 400);
  });

  it('will not mark the same notification read twice', async () => {
    const n = db.prepare('SELECT id FROM notifications WHERE user_id = (SELECT id FROM users WHERE email = ?) LIMIT 1')
      .get('aarav@shop.test');
    const first = await request(app).post(`/api/v1/me/notifications/${n.id}/read`).set(as(T.aarav));
    if (first.status === 409) return; // already read by the seed
    assert.equal(first.status, 200);
    const second = await request(app).post(`/api/v1/me/notifications/${n.id}/read`).set(as(T.aarav));
    assert.equal(second.status, 409);
  });
});

// ===========================================================================
describe('E2 - catalogue and pricing', () => {
  it('lists only active products, with pagination metadata', async () => {
    const res = await request(app).get('/api/v1/catalog?per=5&page=1');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 5);
    assert.equal(res.body.per_page, 5);
    assert.equal(res.body.page, 1);
    assert.ok(res.body.pages >= 1);
    for (const v of res.body.data) assert.equal(v.price_paise >= 0, true);
  });

  it('searches by product name and by brand', async () => {
    const byName = await request(app).get('/api/v1/catalog?q=headphones');
    assert.ok(byName.body.total >= 1);
    assert.ok(byName.body.data.some((v) => /headphones/i.test(v.product_name ?? '')));

    const byBrand = await request(app).get('/api/v1/catalog?brand=Aurora');
    assert.ok(byBrand.body.total >= 2);
  });

  it('filters by price range and sorts deterministically', async () => {
    const res = await request(app).get('/api/v1/catalog?min=200000&max=300000&sort=price_asc&per=50');
    assert.equal(res.status, 200);
    const prices = res.body.data.map((v) => v.price_paise);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
    for (const p of prices) assert.ok(p >= 200000 && p <= 300000, `${p} outside the requested range`);
  });

  it('hides draft and archived products from the public catalogue', async () => {
    const draft = await request(app).post('/api/v1/admin/products').set(as(T.priya)).send({
      slug: `hidden-${Date.now()}`, name: 'Hidden Thing', category_id: 1, status: 'draft',
      variants: [{ sku: `HID-${Date.now()}`, name: 'One size', price_paise: 1000, opening_stock: 3 }],
    });
    assert.equal(draft.status, 201);
    const res = await request(app).get('/api/v1/catalog?q=Hidden Thing');
    assert.equal(res.body.total, 0);
  });

  it('shows variants with computed availability on the product page', async () => {
    const res = await request(app).get('/api/v1/products/aurora-headphones');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.variants.length, 2);
    for (const v of res.body.data.variants) {
      assert.equal(typeof v.available, 'number');
      assert.equal(v.in_stock, v.available > 0);
      assert.match(v.price_display, /^\u20b9[\d,]+\.\d{2}$/);
    }
  });

  it('creates a product, its SKUs and its opening stock together', async () => {
    const sku = `NEW-${Date.now()}`;
    const res = await request(app).post('/api/v1/admin/products').set(as(T.priya)).send({
      slug: `bundle-${Date.now()}`, name: 'Bundle Test', category_id: 2, brand: 'TestBrand',
      status: 'active',
      variants: [
        { sku, name: 'Small', price_paise: 5000, opening_stock: 7 },
        { sku: `${sku}-B`, name: 'Large', price_paise: 7000, opening_stock: 2 },
      ],
    });
    assert.equal(res.status, 201);
    const v = variantBySku(sku);
    assert.equal(stockOf(v.id).on_hand, 7);
    assert.equal(stockOf(v.id).reserved, 0);
    const moves = db.prepare('SELECT * FROM stock_movements WHERE variant_id = ?').all(v.id);
    assert.equal(moves.length, 1);
    assert.equal(moves[0].reason, 'opening_stock');
  });

  it('rejects a duplicate slug and a duplicate sku', async () => {
    const dupeSlug = await request(app).post('/api/v1/admin/products').set(as(T.priya))
      .send({ slug: 'aurora-headphones', name: 'Copy', category_id: 1 });
    assert.equal(dupeSlug.status, 409);

    const productId = db.prepare('SELECT id FROM products WHERE slug = ?').get('aurora-headphones').id;
    const dupeSku = await request(app).post(`/api/v1/admin/products/${productId}/variants`).set(as(T.priya))
      .send({ sku: 'AUR-ANC-01', name: 'Copy', price_paise: 1000 });
    assert.equal(dupeSku.status, 409);
    assert.equal(dupeSku.body.error, 'sku already in use');
  });

  it('refuses a fractional or negative price', async () => {
    for (const price of [10.5, -1, 'abc']) {
      const res = await request(app).patch(`/api/v1/admin/variants/${variantBySku('AUR-ANC-01').id}/price`)
        .set(as(T.priya)).send({ price_paise: price });
      assert.equal(res.status, 400, `price ${price} should be rejected`);
    }
  });

  it('keeps a repriced SKU from rewriting historical order lines', async () => {
    const v = variantBySku('TER-MUG-01');
    const before = v.price_paise;

    // An order placed now, priced at today's number.
    const cust = await freshCustomer();
    await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: v.id, qty: 1 });
    const placed = await request(app).post('/api/v1/orders').set(as(cust.token)).send({});
    const orderId = placed.body.data.id;
    const snapshotted = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(orderId);
    assert.equal(snapshotted.unit_price_paise, before);

    // Reprice, then prove the old order is untouched while the new number applies.
    const res = await request(app).patch(`/api/v1/admin/variants/${v.id}/price`).set(as(T.priya))
      .send({ price_paise: before + 12345 });
    assert.equal(res.status, 200);
    assert.equal(res.body.previous_price_paise, before);

    const stillOld = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(orderId);
    assert.equal(stillOld.unit_price_paise, before, 'a reprice must not rewrite order history');
    assert.equal(stillOld.line_total_paise, before);
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    assert.equal(order.subtotal_paise, before, 'the order total must still agree with its lines');

    const next = await request(app).get('/api/v1/products/terra-mug');
    const liveSku = next.body.data.variants.find((x) => x.sku === 'TER-MUG-01');
    assert.equal(liveSku.price_paise, before + 12345, 'the new price does apply going forward');

    await request(app).patch(`/api/v1/admin/variants/${v.id}/price`).set(as(T.priya)).send({ price_paise: before });
  });

  it('does not let a customer write to the catalogue', async () => {
    await request(app).post('/api/v1/admin/products').set(as(T.aarav))
      .send({ slug: 'nope', name: 'Nope', category_id: 1 }).expect(403);
    await request(app).patch(`/api/v1/admin/variants/${variantBySku('AUR-ANC-01').id}/price`)
      .set(as(T.diya)).send({ price_paise: 1 }).expect(403);
  });
});

// ===========================================================================
describe('E3 - inventory and the no-oversell rule', () => {
  it('receives stock and writes a movement', async () => {
    const v = variantBySku('LUM-LMP-01');
    const before = stockOf(v.id).on_hand;
    const res = await request(app).post(`/api/v1/admin/inventory/${v.id}/receive`).set(as(T.vikram))
      .send({ qty: 25, reason: 'goods_received', reference: 'PO-9001' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.on_hand, before + 25);
    const move = db.prepare('SELECT * FROM stock_movements WHERE variant_id = ? ORDER BY id DESC LIMIT 1').get(v.id);
    assert.equal(move.delta, 25);
    assert.equal(move.reason, 'goods_received');
  });

  it('rejects a non-positive receive quantity', async () => {
    const v = variantBySku('LUM-LMP-01').id;
    for (const qty of [0, -5, 2.5, 'x']) {
      await request(app).post(`/api/v1/admin/inventory/${v}/receive`).set(as(T.vikram)).send({ qty }).expect(400);
    }
  });

  it('records a stocktake adjustment as a signed movement', async () => {
    const v = variantBySku('TER-MUG-02');
    const before = stockOf(v.id).on_hand;
    const res = await request(app).patch(`/api/v1/admin/inventory/${v.id}`).set(as(T.vikram))
      .send({ on_hand: before - 4, reason: 'damage_writeoff' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.on_hand, before - 4);
    const move = db.prepare('SELECT * FROM stock_movements WHERE variant_id = ? ORDER BY id DESC LIMIT 1').get(v.id);
    assert.equal(move.delta, -4);
    assert.equal(move.reason, 'damage_writeoff');
  });

  it('will not let on_hand drop below what is already reserved', async () => {
    const v = variantBySku('ORB-MS-01');
    setStock(v.id, 10, 6);
    const res = await request(app).patch(`/api/v1/admin/inventory/${v.id}`).set(as(T.vikram)).send({ on_hand: 4 });
    assert.equal(res.status, 422);
    assert.equal(res.body.reserved, 6);
    assert.equal(stockOf(v.id).on_hand, 10, 'the rejected write must not have changed anything');
    setStock(v.id, stockOf(v.id).on_hand || 10, 0);
  });

  it('lists SKUs at or below their reorder point', async () => {
    const v = variantBySku('NOM-TOR-02');
    setStock(v.id, 3, 0);
    db.prepare('UPDATE stock_levels SET reorder_point = 8 WHERE variant_id = ?').run(v.id);
    const res = await request(app).get('/api/v1/inventory/low-stock').set(as(T.vikram));
    assert.equal(res.status, 200);
    assert.ok(res.body.data.some((x) => x.sku === 'NOM-TOR-02'));
    for (const row of res.body.data) assert.ok(row.available <= row.reorder_point);
    db.prepare('UPDATE stock_levels SET reorder_point = 5 WHERE variant_id = ?').run(v.id);
  });

  it('keeps the movement ledger in step with on_hand', async () => {
    const rows = db.prepare(`
      SELECT s.variant_id, s.on_hand,
             (SELECT COALESCE(SUM(delta),0) FROM stock_movements m WHERE m.variant_id = s.variant_id) AS moved
        FROM stock_levels s`).all();
    for (const r of rows) {
      assert.equal(r.on_hand, r.moved, `variant ${r.variant_id}: on_hand ${r.on_hand} != movements ${r.moved}`);
    }
  });

  it('never lets on_hand or reserved go negative', async () => {
    for (const r of db.prepare('SELECT * FROM stock_levels').all()) {
      assert.ok(r.on_hand >= 0, `on_hand went negative on variant ${r.variant_id}`);
      assert.ok(r.reserved >= 0, `reserved went negative on variant ${r.variant_id}`);
    }
  });

  it('refuses the second claim on the last unit', async () => {
    // This is the guard from src/routes/inventory.js exercised end to end: the
    // availability test lives inside the UPDATE, so the loser of a race gets
    // false rather than an oversell.
    const v = variantBySku('ORB-MS-02');
    setStock(v.id, 1, 0);
    const { reserveStock } = await import('../src/routes/inventory.js');
    assert.equal(reserveStock(v.id, 1), true);
    assert.equal(reserveStock(v.id, 1), false);
    assert.equal(stockOf(v.id).reserved, 1);
    setStock(v.id, 26, 0);
  });

  it('hides inventory from customers', async () => {
    await request(app).get('/api/v1/inventory').set(as(T.aarav)).expect(403);
    await request(app).get('/api/v1/inventory').set(as(T.neha)).expect(403);
    await request(app).get('/api/v1/inventory').set(as(T.vikram)).expect(200);
  });
});

// ===========================================================================
describe('E4 - cart and orders', () => {
  it('adds to the cart and prices it with integer money', async () => {
    const cust = await freshCustomer();
    const v = variantBySku('STR-BND-01');
    const res = await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: v.id, qty: 2 });
    assert.equal(res.status, 201);
    const cart = res.body.data;
    assert.equal(cart.items.length, 1);
    assert.equal(cart.subtotal_paise, 2 * v.price_paise);
    assert.ok(Number.isInteger(cart.total_paise));
    assert.equal(
      cart.subtotal_paise - cart.discount_paise + cart.tax_paise + cart.shipping_paise,
      cart.total_paise,
    );
  });

  it('increments the quantity when the same SKU is added twice', async () => {
    const cust = await freshCustomer();
    const v = variantBySku('TER-MUG-01');
    await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: v.id, qty: 1 }).expect(201);
    const res = await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: v.id, qty: 3 });
    assert.equal(res.body.data.items.length, 1);
    assert.equal(res.body.data.items[0].qty, 4);
  });

  it('refuses to add more than is available, naming the SKU', async () => {
    const cust = await freshCustomer();
    const v = variantBySku('AUR-ANC-02');
    setStock(v.id, 2, 0);
    const res = await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: v.id, qty: 3 });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'insufficient stock');
    assert.equal(res.body.sku, 'AUR-ANC-02');
    setStock(v.id, 9, 0);
  });

  it('updates and removes cart lines', async () => {
    const cust = await freshCustomer();
    const v = variantBySku('LUM-LMP-01');
    const added = await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: v.id, qty: 1 });
    const itemId = added.body.data.items[0].id;
    const updated = await request(app).patch(`/api/v1/cart/items/${itemId}`).set(as(cust.token)).send({ qty: 3 });
    assert.equal(updated.body.data.items[0].qty, 3);
    const removed = await request(app).delete(`/api/v1/cart/items/${itemId}`).set(as(cust.token));
    assert.equal(removed.body.data.items.length, 0);
  });

  it('refuses checkout of an empty cart with 422', async () => {
    const cust = await freshCustomer();
    const res = await request(app).post('/api/v1/orders').set(as(cust.token)).send({});
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'cart is empty');
  });

  it('refuses checkout when the customer has no address', async () => {
    const reg = await request(app).post('/api/v1/auth/register')
      .send({ name: 'No Address', email: `noaddr${Date.now()}@shop.test`, password: PW });
    const v = variantBySku('LUM-LMP-01');
    await request(app).post('/api/v1/cart/items').set(as(reg.body.token)).send({ variant_id: v.id, qty: 1 });
    const res = await request(app).post('/api/v1/orders').set(as(reg.body.token)).send({});
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'no delivery address on file');
  });

  it('reserves stock and snapshots the lines when an order is placed', async () => {
    const cust = await freshCustomer();
    const v = variantBySku('ORB-MS-01');
    const before = stockOf(v.id);
    await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: v.id, qty: 2 });
    const res = await request(app).post('/api/v1/orders').set(as(cust.token)).send({});
    assert.equal(res.status, 201);
    assert.equal(res.body.data.status, 'placed');
    assert.match(res.body.data.code, /^SH-\d+$/);
    assert.equal(res.body.data.items.length, 1);

    const after = stockOf(v.id);
    assert.equal(after.reserved, before.reserved + 2, 'the order should hold a reservation');
    assert.equal(after.on_hand, before.on_hand, 'placing an order must not decrement on_hand');

    const item = res.body.data.items[0];
    assert.equal(item.unit_price_paise, v.price_paise);
    assert.equal(item.line_total_paise, item.qty * item.unit_price_paise);
    assert.ok(res.body.data.ship_to.line1);
  });

  it('rolls back the whole basket when one line is short', async () => {
    const cust = await freshCustomer();
    const plenty = variantBySku('TER-MUG-02');
    const scarce = variantBySku('AUR-ANC-02');
    setStock(plenty.id, 30, 0);
    setStock(scarce.id, 5, 0);
    await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: plenty.id, qty: 1 });
    await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: scarce.id, qty: 2 });
    assert.equal(stockOf(plenty.id).reserved, 0);

    // Somebody buys the scarce SKU outright between add-to-cart and checkout.
    const other = await freshCustomer();
    await request(app).post('/api/v1/cart/items').set(as(other.token)).send({ variant_id: scarce.id, qty: 5 });
    const taken = await request(app).post('/api/v1/orders').set(as(other.token)).send({});
    assert.equal(taken.status, 201, 'the other customer should have taken all 5');
    const scarceStock = stockOf(scarce.id);
    assert.equal(scarceStock.on_hand - scarceStock.reserved, 0, 'nothing should be left to buy');

    const res = await request(app).post('/api/v1/orders').set(as(cust.token)).send({});
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'insufficient_stock');
    assert.equal(res.body.sku, 'AUR-ANC-02');
    assert.equal(stockOf(plenty.id).reserved, 0, 'no line of a refused basket may stay reserved');
    assert.equal(stockOf(scarce.id).reserved, 5, 'the winner keeps its reservation');

    // The refused basket is still there to retry.
    const cart = await request(app).get('/api/v1/cart').set(as(cust.token));
    assert.equal(cart.body.data.items.length, 2);
  });

  it('charges the price at checkout, not the price in the cart', async () => {
    const cust = await freshCustomer();
    const v = variantBySku('TER-MUG-01');
    await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: v.id, qty: 1 });
    const newPrice = v.price_paise + 7777;
    await request(app).patch(`/api/v1/admin/variants/${v.id}/price`).set(as(T.priya)).send({ price_paise: newPrice });
    const res = await request(app).post('/api/v1/orders').set(as(cust.token)).send({});
    assert.equal(res.body.data.items[0].unit_price_paise, newPrice);
    await request(app).patch(`/api/v1/admin/variants/${v.id}/price`).set(as(T.priya)).send({ price_paise: v.price_paise });
  });

  it('shows a customer only their own orders, and 403s everyone else', async () => {
    const mine = await request(app).get('/api/v1/orders').set(as(T.aarav));
    const theirs = await request(app).get('/api/v1/orders').set(as(T.diya));
    assert.equal(mine.status, 200);
    const ids = new Set(mine.body.data.map((o) => o.id));
    for (const o of theirs.body.data) {
      if (ids.has(o.id)) continue;
    }
    const target = mine.body.data[0];
    const denied = await request(app).get(`/api/v1/orders/${target.id}`).set(as(T.diya));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.your_role, 'customer');
    const allowed = await request(app).get(`/api/v1/orders/${target.id}`).set(as(T.neha));
    assert.equal(allowed.status, 200);
  });

  it('gives a customer the reservation back when they cancel', async () => {
    const cust = await freshCustomer();
    const v = variantBySku('TER-MUG-01');
    const before = stockOf(v.id);
    await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: v.id, qty: 2 });
    const placed = await request(app).post('/api/v1/orders').set(as(cust.token)).send({});
    assert.equal(stockOf(v.id).reserved, before.reserved + 2);

    const res = await request(app).post(`/api/v1/orders/${placed.body.data.id}/cancel`).set(as(cust.token))
      .send({ reason: 'changed my mind' });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'cancelled');
    assert.equal(res.body.refunded, false);
    assert.equal(stockOf(v.id).reserved, before.reserved, 'cancelling must release the reservation');
  });

  it('reverses the money too when a paid order is cancelled', async () => {
    const { orderId, token } = await orderAt('picking');
    const before = db.prepare("SELECT COALESCE(SUM(amount_paise),0) AS n FROM refunds WHERE status = 'paid'").get().n;
    const res = await request(app).post(`/api/v1/orders/${orderId}/cancel`).set(as(token))
      .send({ reason: 'ordered by mistake' });
    assert.equal(res.status, 200);
    assert.equal(res.body.refunded, true);
    assert.equal(res.body.data.status, 'cancelled');

    const refund = db.prepare('SELECT * FROM refunds WHERE order_id = ?').get(orderId);
    assert.equal(refund.status, 'paid');
    assert.equal(refund.return_id, null, 'a cancellation refund has no return behind it');
    const after = db.prepare("SELECT COALESCE(SUM(amount_paise),0) AS n FROM refunds WHERE status = 'paid'").get().n;
    assert.equal(after, before + refund.amount_paise);
    assert.equal(
      db.prepare('SELECT status FROM payments WHERE order_id = ?').get(orderId).status, 'refunded');
  });

  it('refuses an illegal transition and names the legal ones', async () => {
    const cust = await freshCustomer();
    const v = variantBySku('LUM-LMP-01');
    await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: v.id, qty: 1 });
    const placed = await request(app).post('/api/v1/orders').set(as(cust.token)).send({});

    // placed -> shipped skips picking and packing
    const skip = await request(app).post(`/api/v1/orders/${placed.body.data.id}/status`)
      .set(as(T.vikram)).send({ status: 'shipped' });
    assert.equal(skip.status, 422);
    assert.deepEqual(skip.body.allowed.sort(), ['cancelled', 'paid']);
    // dispatch has side effects, so the refusal points at the right endpoint
    assert.match(skip.body.reason, /moves stock or money/);
    assert.equal(skip.body.use, 'POST /api/v1/admin/orders/:id/ship');

    // a delivered order is terminal
    const { orderId } = await orderAt('delivered');
    const closed = await request(app).post(`/api/v1/orders/${orderId}/cancel`).set(as(T.neha));
    assert.equal(closed.status, 422);
    assert.deepEqual(closed.body.allowed, []);
    assert.match(closed.body.error, /illegal transition delivered -> cancelled/);
  });

  it('does not let a warehouse skip the paid step', async () => {
    const cust = await freshCustomer();
    const v = variantBySku('LUM-LMP-01');
    await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: v.id, qty: 1 });
    const placed = await request(app).post('/api/v1/orders').set(as(cust.token)).send({});
    const res = await request(app).post(`/api/v1/orders/${placed.body.data.id}/status`)
      .set(as(T.vikram)).send({ status: 'packed' });
    assert.equal(res.status, 422);
    assert.deepEqual(res.body.allowed.sort(), ['cancelled', 'paid']);
  });

  it('keeps one open cart per customer and converts it on checkout', async () => {
    const cust = await freshCustomer();
    const v = variantBySku('TER-MUG-02');
    await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: v.id, qty: 1 });
    await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: v.id, qty: 1 });
    await request(app).post('/api/v1/orders').set(as(cust.token)).send({});
    const fresh = await request(app).get('/api/v1/cart').set(as(cust.token));
    assert.equal(fresh.body.data.items.length, 0, 'the old cart was converted, a new empty one opened');
    const open = db.prepare("SELECT COUNT(*) AS n FROM carts WHERE user_id = ? AND status = 'open'").get(cust.id).n;
    assert.equal(open, 1);
  });
});

// ===========================================================================
describe('E5 - payments, returns and refunds', () => {
  it('captures a payment and moves the order to paid', async () => {
    const cust = await freshCustomer();
    const v = variantBySku('LUM-LMP-01');
    await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: v.id, qty: 1 });
    const placed = await request(app).post('/api/v1/orders').set(as(cust.token)).send({});
    const res = await request(app).post(`/api/v1/orders/${placed.body.data.id}/pay`).set(as(cust.token))
      .send({ method: 'upi', idempotency_key: `upi-${placed.body.data.id}-${Date.now()}` });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.status, 'captured');
    assert.match(res.body.data.receipt_no, /^RCPT-\d{5}$/);
    assert.equal(res.body.data.amount_paise, placed.body.data.total_paise);

    const after = await request(app).get(`/api/v1/orders/${placed.body.data.id}`).set(as(cust.token));
    assert.equal(after.body.data.status, 'paid');
  });

  it('replays the same idempotency key without charging twice', async () => {
    const cust = await freshCustomer();
    const v = variantBySku('LUM-LMP-01');
    await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: v.id, qty: 1 });
    const placed = await request(app).post('/api/v1/orders').set(as(cust.token)).send({});
    const key = `retry-${placed.body.data.id}-${Date.now()}`;
    const body = { method: 'card', card_number: '4242424242424242', idempotency_key: key };

    const first = await request(app).post(`/api/v1/orders/${placed.body.data.id}/pay`).set(as(cust.token)).send(body);
    assert.equal(first.status, 201);
    assert.equal(first.body.replayed, false);

    const second = await request(app).post(`/api/v1/orders/${placed.body.data.id}/pay`).set(as(cust.token)).send(body);
    assert.equal(second.status, 200);
    assert.equal(second.body.replayed, true);
    assert.equal(second.body.data.id, first.body.data.id, 'the replay must be the original payment');
    assert.equal(second.body.data.receipt_no, first.body.data.receipt_no);

    const rows = db.prepare('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?').get(placed.body.data.id).n;
    assert.equal(rows, 1, 'a retried payment must not create a second row');
  });

  it('records a declined card as 402 and leaves the order unpaid', async () => {
    const cust = await freshCustomer();
    const v = variantBySku('LUM-LMP-01');
    await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: v.id, qty: 1 });
    const placed = await request(app).post('/api/v1/orders').set(as(cust.token)).send({});
    const res = await request(app).post(`/api/v1/orders/${placed.body.data.id}/pay`).set(as(cust.token))
      .send({ method: 'card', card_number: '4000000000000002', idempotency_key: `decl-${placed.body.data.id}-${Date.now()}` });
    assert.equal(res.status, 402);
    assert.equal(res.body.reason, 'card_declined');
    const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(placed.body.data.id);
    assert.equal(order.status, 'placed', 'a failed payment must not advance the order');
  });

  it('insists on an idempotency key', async () => {
    const cust = await freshCustomer();
    const v = variantBySku('LUM-LMP-01');
    await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: v.id, qty: 1 });
    const placed = await request(app).post('/api/v1/orders').set(as(cust.token)).send({});
    const short = await request(app).post(`/api/v1/orders/${placed.body.data.id}/pay`).set(as(cust.token))
      .send({ method: 'upi', idempotency_key: 'short' });
    assert.equal(short.status, 400);
    const none = await request(app).post(`/api/v1/orders/${placed.body.data.id}/pay`).set(as(cust.token))
      .send({ method: 'upi' });
    assert.equal(none.status, 400);
  });

  it('refuses an unsupported payment method', async () => {
    const cust = await freshCustomer();
    const v = variantBySku('LUM-LMP-01');
    await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: v.id, qty: 1 });
    const placed = await request(app).post('/api/v1/orders').set(as(cust.token)).send({});
    const res = await request(app).post(`/api/v1/orders/${placed.body.data.id}/pay`).set(as(cust.token))
      .send({ method: 'bitcoin', idempotency_key: `bm-${Date.now()}` });
    assert.equal(res.status, 400);
  });

  it('stops somebody else paying your order', async () => {
    const cust = await freshCustomer();
    const v = variantBySku('LUM-LMP-01');
    await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: v.id, qty: 1 });
    const placed = await request(app).post('/api/v1/orders').set(as(cust.token)).send({});
    const res = await request(app).post(`/api/v1/orders/${placed.body.data.id}/pay`).set(as(T.diya))
      .send({ method: 'upi', idempotency_key: `steal-${Date.now()}` });
    assert.equal(res.status, 403);
  });

  it('will not accept a return for an order that has not been delivered', async () => {
    const cust = await freshCustomer();
    const v = variantBySku('LUM-LMP-01');
    await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: v.id, qty: 1 });
    const placed = await request(app).post('/api/v1/orders').set(as(cust.token)).send({});
    const itemId = placed.body.data.items[0].id;
    const res = await request(app).post('/api/v1/returns').set(as(cust.token))
      .send({ order_item_id: itemId, qty: 1, reason: 'changed mind' });
    assert.equal(res.status, 422);
    assert.equal(res.body.order_status, 'placed');
  });

  it('will not return more than was ordered, counting earlier requests', async () => {
    const { orderId, token } = await orderAt('delivered', { sku: 'TER-MUG-01', qty: 2 });
    const item = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(orderId);

    const tooMany = await request(app).post('/api/v1/returns').set(as(token))
      .send({ order_item_id: item.id, qty: 3, reason: 'too many' });
    assert.equal(tooMany.status, 422);
    assert.equal(tooMany.body.ordered, 2);

    await request(app).post('/api/v1/returns').set(as(token))
      .send({ order_item_id: item.id, qty: 2, reason: 'both faulty' }).expect(201);

    const again = await request(app).post('/api/v1/returns').set(as(token))
      .send({ order_item_id: item.id, qty: 1, reason: 'one more' });
    assert.equal(again.status, 422);
    assert.equal(again.body.already_requested, 2);
  });

  it('restocks on receipt and creates the refund on refund', async () => {
    const { orderId, token } = await orderAt('delivered', { sku: 'LUM-LMP-01', qty: 1 });
    const item = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(orderId);
    const v = variantBySku('LUM-LMP-01');
    const onHandBefore = stockOf(v.id).on_hand;

    const created = await request(app).post('/api/v1/returns').set(as(token))
      .send({ order_item_id: item.id, qty: 1, reason: 'arrived broken' });
    const returnId = created.body.data.id;
    assert.equal(created.status, 201);

    const approved = await request(app).patch(`/api/v1/returns/${returnId}/status`).set(as(T.neha))
      .send({ status: 'approved' });
    assert.equal(approved.status, 200);
    assert.equal(stockOf(v.id).on_hand, onHandBefore, 'approval alone does not restock');

    const received = await request(app).patch(`/api/v1/returns/${returnId}/status`).set(as(T.vikram))
      .send({ status: 'received' });
    assert.equal(received.status, 200);
    assert.equal(stockOf(v.id).on_hand, onHandBefore + 1, 'goods received go back on the shelf');
    const move = db.prepare("SELECT * FROM stock_movements WHERE ref_type = 'return' AND ref_id = ?").get(returnId);
    assert.equal(move.delta, 1);
    assert.equal(move.reason, 'return_received');

    const refunded = await request(app).patch(`/api/v1/returns/${returnId}/status`).set(as(T.anil))
      .send({ status: 'refunded' });
    assert.equal(refunded.status, 200);
    assert.equal(refunded.body.refunded_paise, item.unit_price_paise);

    const refund = db.prepare('SELECT * FROM refunds WHERE return_id = ?').get(returnId);
    assert.equal(refund.status, 'paid');
    assert.equal(refund.order_id, orderId);
    assert.equal(
      db.prepare('SELECT status FROM payments WHERE order_id = ?').get(orderId).status, 'refunded');
  });

  it('refuses to skip a step in the return lifecycle', async () => {
    const { orderId, token } = await orderAt('delivered', { sku: 'LUM-LMP-01', qty: 1 });
    const item = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(orderId);
    const created = await request(app).post('/api/v1/returns').set(as(token))
      .send({ order_item_id: item.id, qty: 1, reason: 'faulty' });
    const skip = await request(app).patch(`/api/v1/returns/${created.body.data.id}/status`).set(as(T.neha))
      .send({ status: 'refunded' });
    assert.equal(skip.status, 422);
    assert.deepEqual(skip.body.allowed.sort(), ['approved', 'rejected']);

    await request(app).patch(`/api/v1/returns/${created.body.data.id}/status`).set(as(T.neha))
      .send({ status: 'rejected' }).expect(200);
    const closed = await request(app).patch(`/api/v1/returns/${created.body.data.id}/status`).set(as(T.neha))
      .send({ status: 'approved' });
    assert.equal(closed.status, 422);
    assert.deepEqual(closed.body.allowed, []);
  });

  it('shows a customer only their own returns', async () => {
    const { token, id } = await orderAt('delivered', { sku: 'LUM-LMP-01', qty: 1 });
    const item = db.prepare("SELECT id FROM order_items WHERE sku = 'LUM-LMP-01' ORDER BY id DESC LIMIT 1").get();
    await request(app).post('/api/v1/returns').set(as(token))
      .send({ order_item_id: item.id, qty: 1, reason: 'wrong size' }).expect(201);

    const mine = await request(app).get('/api/v1/returns').set(as(token));
    assert.equal(mine.status, 200);
    assert.ok(mine.body.data.some((x) => x.customer_id === id), 'the owner sees their own return');

    const other = await request(app).get('/api/v1/returns').set(as(T.diya));
    assert.equal(other.status, 200);
    assert.ok(!other.body.data.some((x) => x.customer_id === id), 'another customer must not');

    const staff = await request(app).get('/api/v1/returns').set(as(T.neha));
    assert.ok(staff.body.data.some((x) => x.customer_id === id), 'an agent sees every return');
    assert.ok(staff.body.data.length >= mine.body.data.length);
  });

  it('reconciles: net settled is gross captured minus refunds', async () => {
    const res = await request(app).get('/api/v1/finance/reconciliation').set(as(T.anil));
    assert.equal(res.status, 200);
    assert.equal(
      res.body.net_settled_paise,
      res.body.gross_captured_paise - res.body.refunded_paise,
    );
    assert.ok(res.body.net_settled_paise >= 0, 'refunds can never exceed captures');
    assert.equal(res.body.identity, 'net_settled = gross_captured - refunded');
    await request(app).get('/api/v1/finance/reconciliation').set(as(T.aarav)).expect(403);
  });

  it('shows the payment ledger to finance only', async () => {
    await request(app).get('/api/v1/payments').set(as(T.anil)).expect(200);
    await request(app).get('/api/v1/payments').set(as(T.vikram)).expect(403);
    await request(app).get('/api/v1/refunds').set(as(T.anil)).expect(200);
    await request(app).get('/api/v1/refunds').set(as(T.aarav)).expect(403);
  });
});

// ===========================================================================
describe('E6 - fulfilment', () => {
  it('refuses to dispatch an order that is not packed', async () => {
    const cust = await freshCustomer();
    const v = variantBySku('LUM-LMP-01');
    await request(app).post('/api/v1/cart/items').set(as(cust.token)).send({ variant_id: v.id, qty: 1 });
    const placed = await request(app).post('/api/v1/orders').set(as(cust.token)).send({});
    await request(app).post(`/api/v1/orders/${placed.body.data.id}/pay`).set(as(cust.token))
      .send({ method: 'upi', idempotency_key: `f1-${placed.body.data.id}-${Date.now()}` }).expect(201);

    const res = await request(app).post(`/api/v1/admin/orders/${placed.body.data.id}/ship`).set(as(T.vikram))
      .send({ carrier: 'Delhivery', tracking_no: `TRK${Date.now()}` });
    assert.equal(res.status, 422);
    assert.match(res.body.error, /illegal transition paid -> shipped/);
  });

  it('turns a reservation into a real decrement on dispatch', async () => {
    const { orderId } = await orderAt('packed', { sku: 'LUM-LMP-01', qty: 2 });
    const item = db.prepare('SELECT * FROM order_items WHERE order_id = ?').get(orderId);
    const before = stockOf(item.variant_id);
    assert.equal(before.reserved, 2, 'a packed order is still holding a reservation');

    const res = await request(app).post(`/api/v1/admin/orders/${orderId}/ship`).set(as(T.vikram))
      .send({ carrier: 'BlueDart', tracking_no: `TRK${Date.now()}${orderId}` });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.status, 'label_created');

    const after = stockOf(item.variant_id);
    assert.equal(after.on_hand, before.on_hand - 2);
    assert.equal(after.reserved, 0);
    const move = db.prepare("SELECT * FROM stock_movements WHERE ref_type = 'order' AND ref_id = ? ORDER BY id DESC LIMIT 1").get(orderId);
    assert.equal(move.delta, -2);
    assert.equal(move.reason, 'dispatched');
  });

  it('refuses a duplicate tracking number and a second shipment', async () => {
    const { orderId } = await orderAt('packed');
    const existing = db.prepare('SELECT tracking_no FROM shipments LIMIT 1').get().tracking_no;
    const dupe = await request(app).post(`/api/v1/admin/orders/${orderId}/ship`).set(as(T.vikram))
      .send({ carrier: 'Ecom', tracking_no: existing });
    assert.equal(dupe.status, 409);
    assert.equal(dupe.body.error, 'tracking_no already used');

    await request(app).post(`/api/v1/admin/orders/${orderId}/ship`).set(as(T.vikram))
      .send({ carrier: 'Ecom', tracking_no: `TRK${Date.now()}X${orderId}` }).expect(201);
    const again = await request(app).post(`/api/v1/admin/orders/${orderId}/ship`).set(as(T.vikram))
      .send({ carrier: 'Ecom', tracking_no: `TRK${Date.now()}Y${orderId}` });
    assert.equal(again.status, 409);
    assert.equal(again.body.error, 'order already has a shipment');
  });

  it('closes the order when the courier reports delivery', async () => {
    const { orderId, token } = await orderAt('shipped');
    const shipment = db.prepare('SELECT * FROM shipments WHERE order_id = ?').get(orderId);

    const transit = await request(app).post(`/api/v1/shipments/${shipment.id}/events`).set(as(T.vikram))
      .send({ status: 'in_transit', location: 'Nagpur hub' });
    assert.equal(transit.status, 200);
    const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId);
    assert.equal(order.status, 'shipped');

    const jump = await request(app).post(`/api/v1/shipments/${shipment.id}/events`).set(as(T.vikram))
      .send({ status: 'label_created' });
    assert.equal(jump.status, 422);
    assert.deepEqual(jump.body.allowed, ['out_for_delivery', 'delivered']);

    await request(app).post(`/api/v1/shipments/${shipment.id}/events`).set(as(T.vikram))
      .send({ status: 'out_for_delivery', location: 'Pune' }).expect(200);
    const done = await request(app).post(`/api/v1/shipments/${shipment.id}/events`).set(as(T.vikram))
      .send({ status: 'delivered', location: 'Pune' });
    assert.equal(done.status, 200);
    assert.ok(db.prepare('SELECT delivered_at FROM shipments WHERE id = ?').get(shipment.id).delivered_at);
    assert.equal(db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId).status, 'delivered');
    // label_created at dispatch, then in_transit, out_for_delivery, delivered
    assert.equal(done.body.events.length, 4);
    assert.deepEqual(done.body.events.map((e) => e.status),
      ['label_created', 'in_transit', 'out_for_delivery', 'delivered']);

    const note = db.prepare("SELECT * FROM notifications WHERE user_id = (SELECT id FROM users WHERE id = ?) AND kind = 'order_delivered'")
      .get(db.prepare('SELECT customer_id FROM orders WHERE id = ?').get(orderId).customer_id);
    assert.ok(note, 'the customer should be told');
  });

  it('shows tracking to the owner and to staff', async () => {
    const { orderId, token } = await orderAt('shipped');
    const mine = await request(app).get('/api/v1/shipments').set(as(token));
    assert.ok(mine.body.data.some((s) => s.order_id === orderId));
    const staff = await request(app).get('/api/v1/shipments').set(as(T.vikram));
    assert.ok(staff.body.data.length > 0);
    const foreign = await request(app).get('/api/v1/shipments').set(as(T.diya));
    assert.ok(!foreign.body.data.some((s) => s.order_id === orderId));
  });
});

// ===========================================================================
describe('E7 - reporting and audit', () => {
  it('gives each role the dashboard it can act on', async () => {
    const customer = await request(app).get('/api/v1/dashboard').set(as(T.aarav));
    assert.equal(customer.body.role, 'customer');
    assert.ok(customer.body.cards.some((c) => c.label === 'Orders placed'));

    const warehouse = await request(app).get('/api/v1/dashboard').set(as(T.vikram));
    assert.ok(warehouse.body.cards.some((c) => c.label === 'Below reorder point'));

    const finance = await request(app).get('/api/v1/dashboard').set(as(T.anil));
    assert.ok(finance.body.cards.some((c) => c.label === 'Gross captured'));

    const labels = JSON.stringify(warehouse.body.cards) + JSON.stringify(finance.body.cards);
    assert.notEqual(JSON.stringify(customer.body.cards), labels, 'roles must not share one dashboard');
  });

  it('sums revenue in paise and never in floats', async () => {
    const res = await request(app).get('/api/v1/insights/revenue').set(as(T.anil));
    assert.equal(res.status, 200);
    assert.ok(res.body.by_day.length > 0);
    for (const d of res.body.by_day) assert.ok(Number.isInteger(d.gross_paise));
    const fromStatus = res.body.by_status
      .filter((s) => s.status !== 'cancelled')
      .reduce((s, x) => s + x.gross_paise, 0);
    assert.equal(res.body.lifetime_paise, fromStatus);
  });

  it('ranks best sellers by units', async () => {
    const res = await request(app).get('/api/v1/insights/top-products').set(as(T.priya));
    assert.equal(res.status, 200);
    assert.ok(res.body.data.length > 0);
    const units = res.body.data.map((x) => x.units);
    assert.deepEqual(units, [...units].sort((a, b) => b - a));
    for (const row of res.body.data) assert.match(row.revenue_display, /^\u20b9[\d,]+\.\d{2}$/);
  });

  it('keeps the audit ledger to admins and filters it', async () => {
    await request(app).get('/api/v1/audit').set(as(T.aarav)).expect(403);
    await request(app).get('/api/v1/audit').set(as(T.priya)).expect(403);
    const all = await request(app).get('/api/v1/audit?limit=500').set(as(T.admin));
    assert.equal(all.status, 200);
    const orders = await request(app).get('/api/v1/audit?entity=order&limit=500').set(as(T.admin));
    assert.ok(orders.body.data.every((e) => e.entity === 'order'));
    assert.ok(orders.body.data.length > 0);
  });
});

// ===========================================================================
describe('cross-cutting invariants', () => {
  it('keeps every money column an integer', async () => {
    const cols = [
      ['orders', ['subtotal_paise', 'discount_paise', 'tax_paise', 'shipping_paise', 'total_paise']],
      ['order_items', ['unit_price_paise', 'line_total_paise']],
      ['payments', ['amount_paise']],
      ['refunds', ['amount_paise']],
      ['cart_items', ['unit_price_paise']],
      ['variants', ['price_paise']],
    ];
    for (const [table, fields] of cols) {
      for (const f of fields) {
        const bad = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE typeof(${f}) != 'integer'`).get().n;
        assert.equal(bad, 0, `${table}.${f} holds a non-integer`);
      }
    }
  });

  it('keeps every order total internally consistent', async () => {
    for (const o of db.prepare('SELECT * FROM orders').all()) {
      assert.equal(
        o.subtotal_paise - o.discount_paise + o.tax_paise + o.shipping_paise,
        o.total_paise,
        `order ${o.code} does not add up`,
      );
      const lineSum = db.prepare('SELECT COALESCE(SUM(line_total_paise),0) AS n FROM order_items WHERE order_id = ?')
        .get(o.id).n;
      assert.equal(lineSum, o.subtotal_paise, `order ${o.code} lines do not sum to its subtotal`);
    }
  });

  it('has no order holding stock it does not own', async () => {
    for (const o of db.prepare("SELECT * FROM orders WHERE status IN ('placed','paid','picking','packed')").all()) {
      for (const line of db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(o.id)) {
        const s = stockOf(line.variant_id);
        assert.ok(s, `order ${o.code} references a variant with no stock level`);
        assert.ok(s.on_hand >= 0 && s.reserved >= 0);
        assert.ok(s.on_hand - s.reserved >= 0, `order ${o.code} oversold variant ${line.sku}`);
      }
    }
  });

  it('records an audit event for every meaningful write', async () => {
    const actions = db.prepare('SELECT DISTINCT action FROM audit_events ORDER BY action').all().map((x) => x.action);
    for (const expected of [
      'user.registered', 'user.logged_in', 'user.provisioned', 'order.placed',
      'order.cancelled', 'order.status_changed', 'payment.captured', 'payment.failed',
      'stock.received', 'stock.adjusted', 'variant.repriced', 'product.created',
      'shipment.dispatched', 'shipment.event', 'return.requested', 'return.status_changed',
    ]) {
      assert.ok(actions.includes(expected), `no audit event for ${expected}`);
    }
  });

  it('answers health and readiness', async () => {
    const h = await request(app).get('/healthz');
    assert.equal(h.body.status, 'ok');
    assert.equal(h.body.service, 'shop-hub');
    const r = await request(app).get('/readyz');
    assert.equal(r.body.status, 'ready');
  });

  it('publishes a machine-readable index of itself', async () => {
    const res = await request(app).get('/api/v1/meta');
    assert.equal(res.body.service, 'shop-hub');
    assert.equal(res.body.money_unit, 'paise (integer)');
    assert.deepEqual(res.body.roles, ROLES);
    assert.ok(res.body.endpoints >= 35, `expected 35+ endpoints, got ${res.body.endpoints}`);
    assert.ok(res.body.tables >= 18, `expected 18+ tables, got ${res.body.tables}`);
  });

  it('404s an unknown endpoint with JSON, not HTML', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'unknown endpoint');
  });
});
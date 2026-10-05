// EPIC E4 - Cart and orders.
//
// Placing an order is the only genuinely hard operation in this system: it has
// to reserve stock for every line atomically, price the order with integer
// money, snapshot the line detail so later price changes cannot rewrite history,
// and refuse cleanly when there is not enough stock.
import { Router } from 'express';
import { db, audit, notify } from '../db.js';
import { requireAuth, requireRole, actorId } from '../auth.js';
import { totalsFor, formatINR } from '../money.js';
import { reserveStock, releaseStock } from './inventory.js';

const r = Router();

/**
 * The order lifecycle. Closed by construction: a status with no outgoing edges
 * is terminal, so "delivered" and "cancelled" can never be moved again. This is
 * the rule the 422 endpoint exists to enforce.
 */
export const ORDER_FLOW = {
  placed:    ['paid', 'cancelled'],
  paid:      ['picking', 'cancelled'],
  picking:   ['packed', 'cancelled'],
  packed:    ['shipped'],
  shipped:   ['delivered'],
  delivered: [],
  cancelled: [],
};

/**
 * The subset of transitions the plain status endpoint may perform.
 *
 * Two edges are deliberately absent. `-> cancelled` and `-> shipped` both have
 * side effects the database must not allow to be skipped: cancelling releases a
 * reservation and may reverse a payment, dispatching commits stock and creates a
 * tracking record. Allowing them here would let a warehouse "ship" an order by
 * changing one field, and the stock ledger would silently stop agreeing with
 * physical inventory. Those two edges live behind their own endpoints.
 */
export const WORKFLOW_FLOW = {
  placed:    [],
  paid:      ['picking'],
  picking:   ['packed'],
  packed:    [],
  shipped:   [],
  delivered: [],
  cancelled: [],
};

/** Where a caller should go instead when the plain endpoint refuses. */
const SIDE_EFFECT_ENDPOINT = {
  shipped: 'POST /api/v1/admin/orders/:id/ship',
  cancelled: 'POST /api/v1/orders/:id/cancel',
};

/** Staff who may see and act on anyone's order. */
const STAFF = ['agent', 'warehouse', 'finance', 'admin'];

function getOrCreateOpenCart(userId) {
  const open = db.prepare("SELECT * FROM carts WHERE user_id = ? AND status = 'open'").get(userId);
  if (open) return open;
  db.prepare("INSERT INTO carts (user_id, status) VALUES (?, 'open')").run(userId);
  return db.prepare("SELECT * FROM carts WHERE user_id = ? AND status = 'open'").get(userId);
}

function cartPayload(cart) {
  const items = db.prepare(`
    SELECT ci.id, ci.qty, ci.unit_price_paise, v.id AS variant_id, v.sku, v.name AS variant_name,
           p.name AS product_name, p.slug AS product_slug,
           (s.on_hand - s.reserved) AS available
      FROM cart_items ci
      JOIN variants v ON v.id = ci.variant_id
      JOIN products p ON p.id = v.product_id
      LEFT JOIN stock_levels s ON s.variant_id = v.id
     WHERE ci.cart_id = ?
     ORDER BY ci.id
  `).all(cart.id).map((i) => ({ ...i, line_total_paise: i.qty * i.unit_price_paise }));
  const totals = totalsFor(items, 0);
  return {
    id: cart.id,
    status: cart.status,
    items,
    item_count: items.reduce((s, i) => s + i.qty, 0),
    ...totals,
    total_display: formatINR(totals.total_paise),
  };
}

// ---------------------------------------------------------------------- cart
r.get('/cart', requireAuth, requireRole('customer'), (req, res) => {
  const cart = getOrCreateOpenCart(actorId(req));
  res.json({ data: cartPayload(cart) });
});

/** US-4.2 Add a SKU to the cart. Adding the same SKU twice increments it. */
r.post('/cart/items', requireAuth, requireRole('customer'), (req, res) => {
  const { variant_id, qty = 1 } = req.body || {};
  const n = Number(qty);
  if (!variant_id || !Number.isInteger(n) || n < 1) {
    return res.status(400).json({ error: 'variant_id and a positive integer qty are required' });
  }
  const v = db.prepare(`
    SELECT v.*, p.status AS product_status,
           COALESCE(s.on_hand - s.reserved, 0) AS available
      FROM variants v
      JOIN products p ON p.id = v.product_id
      LEFT JOIN stock_levels s ON s.variant_id = v.id
     WHERE v.id = ?
  `).get(variant_id);
  if (!v || !v.active || v.product_status !== 'active') {
    return res.status(404).json({ error: 'variant not available' });
  }
  if (n > v.available) {
    // The cart does not reserve, so this can still change by checkout time -
    // that is exactly what the order-time reservation is for.
    return res.status(409).json({ error: 'insufficient stock', sku: v.sku, available: v.available });
  }

  const cart = getOrCreateOpenCart(actorId(req));
  const existing = db.prepare('SELECT * FROM cart_items WHERE cart_id = ? AND variant_id = ?')
    .get(cart.id, variant_id);
  const wanted = (existing?.qty ?? 0) + n;
  if (wanted > v.available) {
    return res.status(409).json({
      error: 'insufficient stock for the combined quantity', sku: v.sku, available: v.available,
    });
  }

  if (existing) {
    db.prepare('UPDATE cart_items SET qty = ? WHERE id = ?').run(wanted, existing.id);
  } else {
    db.prepare('INSERT INTO cart_items (cart_id, variant_id, qty, unit_price_paise) VALUES (?,?,?,?)')
      .run(cart.id, variant_id, n, v.price_paise);
  }
  audit(actorId(req), 'cart', cart.id, 'cart.item_added', { sku: v.sku, qty: n });
  res.status(201).json({ data: cartPayload(getOrCreateOpenCart(actorId(req))) });
});

r.patch('/cart/items/:id', requireAuth, requireRole('customer'), (req, res) => {
  const { qty } = req.body || {};
  const n = Number(qty);
  const item = db.prepare(`
    SELECT ci.*, (s.on_hand - s.reserved) AS available
      FROM cart_items ci
      LEFT JOIN stock_levels s ON s.variant_id = ci.variant_id
     WHERE ci.id = ? AND ci.cart_id = ?`).get(req.params.id, getOrCreateOpenCart(actorId(req)).id);
  if (!item) return res.status(404).json({ error: 'cart item not found' });
  if (n === 0) {
    db.prepare('DELETE FROM cart_items WHERE id = ?').run(item.id);
    return res.json({ data: cartPayload(getOrCreateOpenCart(actorId(req))) });
  }
  if (!Number.isInteger(n) || n < 1) {
    return res.status(400).json({ error: 'qty must be a positive integer' });
  }
  if (n > item.available) {
    return res.status(409).json({ error: 'insufficient stock', available: item.available });
  }
  db.prepare('UPDATE cart_items SET qty = ? WHERE id = ?').run(n, item.id);
  res.json({ data: cartPayload(getOrCreateOpenCart(actorId(req))) });
});

r.delete('/cart/items/:id', requireAuth, requireRole('customer'), (req, res) => {
  const info = db.prepare('DELETE FROM cart_items WHERE id = ? AND cart_id = ?')
    .run(req.params.id, getOrCreateOpenCart(actorId(req)).id);
  if (info.changes === 0) return res.status(404).json({ error: 'cart item not found' });
  res.json({ data: cartPayload(getOrCreateOpenCart(actorId(req))) });
});

// -------------------------------------------------------------------- orders
/**
 * US-4.4 Place the order.
 *
 * All-or-nothing: every line reserves or the whole thing rolls back, so a
 * basket is never half-reserved. The failure names the SKU rather than saying
 * "out of stock", because the caller needs to know which line to change.
 */
r.post('/orders', requireAuth, requireRole('customer'), (req, res) => {
  const uid = actorId(req);
  const cart = getOrCreateOpenCart(uid);
  const items = db.prepare('SELECT * FROM cart_items WHERE cart_id = ?').all(cart.id);
  if (items.length === 0) return res.status(422).json({ error: 'cart is empty' });

  let address;
  if (req.body?.address_id) {
    address = db.prepare('SELECT * FROM addresses WHERE id = ? AND user_id = ?')
      .get(req.body.address_id, uid);
    if (!address) return res.status(404).json({ error: 'address not found' });
  } else {
    address = db.prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id LIMIT 1').get(uid);
    if (!address) return res.status(422).json({ error: 'no delivery address on file' });
  }
  const shipTo = JSON.stringify({
    label: address.label, line1: address.line1, city: address.city, pincode: address.pincode,
  });

  const outcome = db.transaction(() => {
    // Pass 1 - check every line before reserving anything, so a basket we are
    // going to refuse costs no writes.
    for (const line of items) {
      const v = db.prepare('SELECT v.sku, COALESCE(s.on_hand - s.reserved, 0) AS available FROM variants v '
        + 'LEFT JOIN stock_levels s ON s.variant_id = v.id WHERE v.id = ?').get(line.variant_id);
      if (!v || v.available < line.qty) {
        return { error: 'insufficient_stock', sku: v?.sku ?? null, available: v?.available ?? 0 };
      }
    }

    // Pass 2 - reserve. The conditional UPDATE is what makes this safe.
    for (const line of items) {
      if (!reserveStock(line.variant_id, line.qty)) {
        return { error: 'insufficient_stock', sku: null, available: 0 };
      }
    }

    // Re-read prices at the moment of order: a cart can sit for days and the
    // shelf price is not a contract.
    const priced = items.map((line) => {
      const v = db.prepare('SELECT sku, name, price_paise FROM variants WHERE id = ?').get(line.variant_id);
      return { variant_id: line.variant_id, sku: v.sku, name: v.name, qty: line.qty, unit_price_paise: v.price_paise };
    });
    const totals = totalsFor(priced, Number(req.body?.discount_paise) || 0);
    const nextId = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM orders').get().n;
    const code = `SH-${10000 + nextId}`;

    const orderId = db.prepare(`
      INSERT INTO orders (code, customer_id, status, subtotal_paise, discount_paise,
                          tax_paise, shipping_paise, total_paise, ship_to)
      VALUES (?,?,'placed',?,?,?,?,?,?)
    `).run(code, uid, totals.subtotal_paise, totals.discount_paise,
      totals.tax_paise, totals.shipping_paise, totals.total_paise, shipTo).lastInsertRowid;

    for (const line of priced) {
      db.prepare(`INSERT INTO order_items (order_id, variant_id, sku, name, qty, unit_price_paise, line_total_paise)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(orderId, line.variant_id, line.sku, line.name, line.qty,
          line.unit_price_paise, line.qty * line.unit_price_paise);
    }
    db.prepare("UPDATE carts SET status = 'converted' WHERE id = ?").run(cart.id);
    notify(uid, 'order_placed', `Order ${code} placed. Total ${formatINR(totals.total_paise)}.`);
    return { orderId, code, totals };
  })();

  if (outcome.error) {
    if (outcome.error === 'insufficient_stock') {
      return res.status(409).json({
        error: 'insufficient_stock', sku: outcome.sku, available: outcome.available,
      });
    }
    return res.status(422).json({ error: outcome.error });
  }

  audit(uid, 'order', outcome.orderId, 'order.placed', {
    code: outcome.code, total_paise: outcome.totals.total_paise,
  });
  res.status(201).json({ data: orderPayload(outcome.orderId) });
});

function orderPayload(orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o) return null;
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(o.id);
  const payment = db.prepare('SELECT status, method, receipt_no FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(o.id);
  const shipment = db.prepare('SELECT * FROM shipments WHERE order_id = ?').get(o.id);
  return {
    ...o,
    ship_to: JSON.parse(o.ship_to),
    items,
    total_display: formatINR(o.total_paise),
    payment: payment ?? null,
    shipment: shipment ?? null,
    allowed_transitions: ORDER_FLOW[o.status] ?? [],
  };
}

/** US-4.6 A customer sees their own orders; staff see all of them. */
r.get('/orders', requireAuth, (req, res) => {
  const { status, page = '1', per = '20' } = req.query;
  const perPage = Math.min(Math.max(Number(per) || 20, 1), 100);
  const pageNo = Math.max(Number(page) || 1, 1);

  const where = [];
  const params = {};
  if (!STAFF.includes(req.user.role)) {
    where.push('customer_id = :me');
    params.me = actorId(req);
  }
  if (status) { where.push('status = :status'); params.status = status; }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM orders ${clause}`).get(params).n;
  const rows = db.prepare(`SELECT * FROM orders ${clause} ORDER BY id DESC LIMIT :limit OFFSET :offset`)
    .all({ ...params, limit: perPage, offset: (pageNo - 1) * perPage })
    .map((o) => ({
      id: o.id, code: o.code, status: o.status, total_paise: o.total_paise,
      total_display: formatINR(o.total_paise), placed_at: o.placed_at,
      item_count: db.prepare('SELECT COALESCE(SUM(qty),0) AS n FROM order_items WHERE order_id = ?').get(o.id).n,
    }));
  res.json({ page: pageNo, per_page: perPage, total, pages: Math.ceil(total / perPage) || 1, data: rows });
});

r.get('/orders/:id', requireAuth, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'order not found' });
  if (!STAFF.includes(req.user.role) && o.customer_id !== actorId(req)) {
    // Someone else's order is a 403 with the roles that would be allowed, not a
    // 404 - the caller is authenticated, they are just not permitted.
    return res.status(403).json({ error: 'forbidden', required_roles: STAFF, your_role: req.user.role });
  }
  const payload = orderPayload(o.id);
  payload.customer = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(o.customer_id);
  res.json({ data: payload });
});

/**
 * US-4.5 Cancel an order.
 *
 * Cancelling a *paid* order reverses the money as well as the stock, because a
 * customer whose order vanished should not have to raise a return to get their
 * own money back.
 */
r.post('/orders/:id/cancel', requireAuth, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'order not found' });
  const isOwner = o.customer_id === actorId(req);
  if (!isOwner && !STAFF.includes(req.user.role)) {
    return res.status(403).json({ error: 'forbidden', required_roles: STAFF, your_role: req.user.role });
  }
  if (!ORDER_FLOW[o.status].includes('cancelled')) {
    return res.status(422).json({
      error: `illegal transition ${o.status} -> cancelled`, allowed: ORDER_FLOW[o.status],
    });
  }

  const result = db.transaction(() => {
    // Goods not yet shipped are still only reserved, so give them back.
    if (o.status === 'placed' || o.status === 'paid') {
      for (const line of db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(o.id)) {
        releaseStock(line.variant_id, line.qty);
      }
    }
    db.prepare("UPDATE orders SET status = 'cancelled', cancel_reason = ?, updated_at = datetime('now') WHERE id = ?")
      .run(req.body?.reason ?? 'cancelled by request', o.id);

    const payment = db.prepare("SELECT * FROM payments WHERE order_id = ? AND status = 'captured'").get(o.id);
    if (payment) {
      db.prepare("UPDATE payments SET status = 'refunded' WHERE id = ?").run(payment.id);
      db.prepare(`INSERT INTO refunds (return_id, order_id, payment_id, amount_paise, status, reason)
                  VALUES (NULL, ?, ?, ?, 'paid', 'order_cancelled')`)
        .run(o.id, payment.id, payment.amount_paise);
    }
    notify(o.customer_id, 'order_cancelled', `Order ${o.code} was cancelled.`);
    return { payment };
  })();

  audit(actorId(req), 'order', o.id, 'order.cancelled', {
    from: o.status, reason: req.body?.reason ?? 'cancelled by request', refunded: !!result.payment,
  });
  res.json({ data: orderPayload(o.id), refunded: !!result.payment });
});

/**
 * US-4.7 Move an order along the pick-and-pack flow. Staff only, and only to a
 * legal successor state. Dispatch and cancellation are refused here and pointed
 * at their own endpoints - see WORKFLOW_FLOW.
 */
r.post('/orders/:id/status', requireAuth, requireRole('warehouse', 'agent', 'admin'), (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'order not found' });
  const next = req.body?.status;
  if (!WORKFLOW_FLOW[o.status]?.includes(next)) {
    const elsewhere = SIDE_EFFECT_ENDPOINT[next];
    return res.status(422).json({
      error: `illegal transition ${o.status} -> ${next}`,
      allowed: ORDER_FLOW[o.status],
      ...(elsewhere
        ? { reason: 'this transition moves stock or money and has its own endpoint', use: elsewhere }
        : {}),
    });
  }
  db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(next, o.id);
  audit(actorId(req), 'order', o.id, 'order.status_changed', { from: o.status, to: next });
  notify(o.customer_id, 'order_update', `Order ${o.code} is now ${next}.`);
  res.json({ data: orderPayload(o.id) });
});

export default r;
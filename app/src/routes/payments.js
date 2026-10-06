// EPIC E5 - Payments, returns and refunds.
//
// The rule this epic exists to protect: money moves once. A retried request, a
// flaky network, or a customer hammering the button must never produce a second
// capture. Idempotency is enforced by a UNIQUE key and checked before charging.
import { Router } from 'express';
import { db, audit, notify } from '../db.js';
import { requireAuth, requireRole, actorId } from '../auth.js';
import { formatINR } from '../money.js';
import { charge, MAX_CHARGE_PAISE } from '../gateway.js';
import { ORDER_FLOW } from './orders.js';
import { releaseStock } from './inventory.js';

const r = Router();

const FINANCE = ['finance', 'admin'];
// The warehouse is here because someone has to physically sign for returned
// goods - that is the `received` step, and no desk role can do it alone.
const RETURNS_STAFF = ['agent', 'warehouse', 'finance', 'admin'];

/** Returns follow their own lifecycle, separate from the order's. */
export const RETURN_FLOW = {
  requested:  ['approved', 'rejected'],
  approved:   ['in_transit'],
  in_transit: ['received'],
  received:   ['refunded'],
  refunded:   [],
  rejected:   [],
};

// ------------------------------------------------------------------- payment
/**
 * US-5.2 Pay an order.
 *
 * The idempotency key is looked up *before* the gateway is called. Replaying a
 * request with the same key returns the original payment and creates no second
 * charge - the same guarantee Stripe and Razorpay give, at the scale of one
 * table and one UNIQUE constraint.
 */
r.post('/orders/:id/pay', requireAuth, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'order not found' });
  const isOwner = o.customer_id === actorId(req);
  if (!isOwner && !['agent', 'finance', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'forbidden', required_roles: ['agent', 'finance', 'admin'], your_role: req.user.role });
  }
  if (o.status === 'cancelled') {
    return res.status(422).json({ error: 'order is cancelled and cannot be paid' });
  }

  const { method = 'card', card_number = '', idempotency_key } = req.body || {};
  if (!['card', 'upi', 'netbanking', 'wallet'].includes(method)) {
    return res.status(400).json({ error: 'method must be card, upi, netbanking or wallet' });
  }
  if (!idempotency_key || String(idempotency_key).length < 8) {
    // Without a key we cannot promise "exactly once", so we refuse rather than
    // quietly accepting a duplicate-charge risk.
    return res.status(422).json({ error: 'idempotency_key of at least 8 characters is required' });
  }

  // Replay: same key, same answer, no second charge.
  const prior = db.prepare('SELECT * FROM payments WHERE idempotency_key = ?').get(idempotency_key);
  if (prior) {
    return res.status(200).json({
      data: prior, replayed: true,
      note: 'idempotency key already used - returning the original payment',
    });
  }

  if (!ORDER_FLOW[o.status].includes('paid')) {
    return res.status(422).json({ error: `illegal transition ${o.status} -> paid`, allowed: ORDER_FLOW[o.status] });
  }

  const result = charge({ amount_paise: o.total_paise, method, card_number, idempotency_key });

  if (result.status === 'failed') {
    // A decline never becomes a payment row. Money did not move and the order
    // keeps its reservation; the failed attempt is evidence in the audit
    // ledger, which is where the finance dashboard counts it from.
    audit(actorId(req), 'order', o.id, 'payment.failed', {
      order: o.code, reason: result.failure_reason,
    });
    return res.status(402).json({
      error: 'payment_failed', reason: result.failure_reason, order_id: o.id,
    });
  }

  const paymentId = db.transaction(() => {
    const id = db.prepare(
      'INSERT INTO payments (order_id, amount_paise, method, status, idempotency_key, receipt_no) VALUES (?,?,?,?,?,?)'
    ).run(o.id, o.total_paise, method, 'captured', idempotency_key, result.receipt_no).lastInsertRowid;
    db.prepare("UPDATE orders SET status = 'paid', updated_at = datetime('now') WHERE id = ?").run(o.id);
    return id;
  })();

  audit(actorId(req), 'payment', paymentId, 'payment.captured', { order: o.code, amount_paise: o.total_paise });
  notify(o.customer_id, 'payment_captured',
    `Payment of ${formatINR(o.total_paise)} received for ${o.code}. Receipt ${result.receipt_no}.`);
  res.status(201).json({
    data: db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId),
    replayed: false,
  });
});

r.get('/payments', requireAuth, requireRole(...FINANCE), (req, res) => {
  const { status } = req.query;
  const rows = status
    ? db.prepare(`SELECT p.*, o.code AS order_code FROM payments p JOIN orders o ON o.id = p.order_id
                   WHERE p.status = ? ORDER BY p.id DESC LIMIT 200`).all(status)
    : db.prepare(`SELECT p.*, o.code AS order_code FROM payments p JOIN orders o ON o.id = p.order_id
                   ORDER BY p.id DESC LIMIT 200`).all();
  const captured = rows.filter((x) => x.status === 'captured');
  const refunded = rows.filter((x) => x.status === 'refunded');
  res.json({
    data: rows,
    summary: {
      count: rows.length,
      captured_paise: captured.reduce((s, x) => s + x.amount_paise, 0),
      refunded_paise: refunded.reduce((s, x) => s + x.amount_paise, 0),
      net_paise: captured.reduce((s, x) => s + x.amount_paise, 0)
        - refunded.reduce((s, x) => s + x.amount_paise, 0),
    },
  });
});

// ------------------------------------------------------------------- returns
/** US-5.4 Request a return against a delivered order line. */
r.post('/returns', requireAuth, requireRole('customer'), (req, res) => {
  const { order_item_id, qty = 1, reason } = req.body || {};
  const n = Number(qty);
  if (!order_item_id || !reason) {
    return res.status(400).json({ error: 'order_item_id and reason are required' });
  }
  const item = db.prepare(`
    SELECT oi.*, o.status AS order_status, o.customer_id
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE oi.id = ?`).get(order_item_id);
  if (!item) return res.status(404).json({ error: 'order item not found' });
  if (item.customer_id !== actorId(req)) {
    return res.status(403).json({ error: 'forbidden', required_roles: ['the order owner'], your_role: req.user.role });
  }
  if (item.order_status !== 'delivered') {
    // You cannot return something that has not arrived.
    return res.status(422).json({ error: 'order must be delivered before it can be returned', order_status: item.order_status });
  }
  if (!Number.isInteger(n) || n < 1 || n > item.qty) {
    return res.status(422).json({ error: 'qty must be between 1 and the quantity ordered', ordered: item.qty });
  }
  const already = db.prepare(
    "SELECT COALESCE(SUM(qty),0) AS n FROM returns WHERE order_item_id = ? AND status <> 'rejected'"
  ).get(order_item_id).n;
  if (already + n > item.qty) {
    return res.status(422).json({ error: 'return quantity exceeds the quantity ordered', ordered: item.qty, already_requested: already });
  }

  const info = db.prepare(
    'INSERT INTO returns (order_id, order_item_id, customer_id, qty, reason, status) VALUES (?,?,?,?,?,\'requested\')'
  ).run(item.order_id, order_item_id, item.customer_id, n, reason);
  audit(actorId(req), 'return', info.lastInsertRowid, 'return.requested', { qty: n, reason });
  res.status(201).json({ data: db.prepare('SELECT * FROM returns WHERE id = ?').get(info.lastInsertRowid) });
});

/**
 * US-5.5 Move a return along.
 *
 * Three side effects are attached to specific transitions, which is the whole
 * reason the lifecycle is a machine and not a free-text status field:
 *   received -> the goods are back on the shelf (on_hand increases)
 *   refunded -> a refund row is created and the payment is marked refunded
 */
r.patch('/returns/:id/status', requireAuth, requireRole(...RETURNS_STAFF), (req, res) => {
  const row = db.prepare('SELECT * FROM returns WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'return not found' });
  const next = req.body?.status;
  if (!RETURN_FLOW[row.status]?.includes(next)) {
    return res.status(422).json({ error: `illegal transition ${row.status} -> ${next}`, allowed: RETURN_FLOW[row.status] });
  }

  const out = db.transaction(() => {
    db.prepare('UPDATE returns SET status = ? WHERE id = ?').run(next, row.id);

    if (next === 'received') {
      const item = db.prepare('SELECT * FROM order_items WHERE id = ?').get(row.order_item_id);
      db.prepare('UPDATE stock_levels SET on_hand = on_hand + ? WHERE variant_id = ?').run(row.qty, item.variant_id);
      db.prepare(`INSERT INTO stock_movements (variant_id, delta, reason, ref_type, ref_id, actor_id)
                  VALUES (?,?,?,?,?,?)`)
        .run(item.variant_id, row.qty, 'return_received', 'return', row.id, actorId(req));
    }

    if (next === 'refunded') {
      const payment = db.prepare("SELECT * FROM payments WHERE order_id = ? AND status = 'captured' ORDER BY id LIMIT 1")
        .get(row.order_id);
      if (!payment) {
        throw Object.assign(new Error('no captured payment on this order'), { status: 422 });
      }
      const item = db.prepare('SELECT * FROM order_items WHERE id = ?').get(row.order_item_id);
      const amount = item.unit_price_paise * row.qty;
      db.prepare(`INSERT INTO refunds (return_id, order_id, payment_id, amount_paise, status, reason)
                  VALUES (?,?,?,?, 'paid', ?)`)
        .run(row.id, row.order_id, payment.id, amount, req.body?.reason ?? 'return_approved');
      db.prepare("UPDATE payments SET status = 'refunded' WHERE id = ?").run(payment.id);
      return { refunded_paise: amount };
    }
    return {};
  })();

  audit(actorId(req), 'return', row.id, 'return.status_changed', { from: row.status, to: next });
  if (next === 'refunded') {
    notify(row.customer_id, 'refund_paid', `Refund of ${formatINR(out.refunded_paise)} issued for your return.`);
  }
  res.json({ data: db.prepare('SELECT * FROM returns WHERE id = ?').get(row.id), ...out });
});

r.get('/returns', requireAuth, (req, res) => {
  const rows = ['agent', 'finance', 'admin'].includes(req.user.role)
    ? db.prepare(`SELECT rt.*, o.code AS order_code FROM returns rt JOIN orders o ON o.id = rt.order_id ORDER BY rt.id DESC LIMIT 200`).all()
    : db.prepare(`SELECT rt.*, o.code AS order_code FROM returns rt JOIN orders o ON o.id = rt.order_id
                   WHERE rt.customer_id = ? ORDER BY rt.id DESC LIMIT 200`).all(actorId(req));
  res.json({ data: rows });
});

// ------------------------------------------------------------------- finance
r.get('/refunds', requireAuth, requireRole(...FINANCE), (_req, res) => {
  res.json({
    data: db.prepare(`SELECT rf.*, o.code AS order_code FROM refunds rf JOIN orders o ON o.id = rf.order_id
                       ORDER BY rf.id DESC LIMIT 200`).all(),
  });
});

/**
 * US-5.6 Reconciliation: the settlement view finance actually checks.
 * Every figure is summed in integer paise and the three must satisfy the
 * identity printed at the bottom - if they ever do not, something is wrong and
 * the page is designed to make that obvious.
 */
r.get('/finance/reconciliation', requireAuth, requireRole(...FINANCE), (_req, res) => {
  const sum = (sql, ...args) => db.prepare(sql).get(...args).n;
  const gross = sum("SELECT COALESCE(SUM(amount_paise),0) AS n FROM payments WHERE status = 'captured'");
  const refunded = sum("SELECT COALESCE(SUM(amount_paise),0) AS n FROM refunds WHERE status = 'paid'");
  const failed = db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'payment.failed'").get().n;
  const pending = db.prepare("SELECT COUNT(*) AS n FROM payments WHERE status = 'pending'").get().n;

  // Guard rail: the refunds we have issued must never exceed what we captured.
  if (refunded > gross) {
    return res.status(500).json({
      error: 'reconciliation_failed', detail: 'refunds exceed captured payments', gross_paise: gross, refunded_paise: refunded,
    });
  }
  res.json({
    gross_captured_paise: gross,
    refunded_paise: refunded,
    net_settled_paise: gross - refunded,
    gross_display: formatINR(gross),
    refunded_display: formatINR(refunded),
    net_display: formatINR(gross - refunded),
    failed_attempts: failed,
    pending_attempts: pending,
    max_single_charge_paise: MAX_CHARGE_PAISE,
    identity: 'net_settled = gross_captured - refunded',
  });
});

export default r;
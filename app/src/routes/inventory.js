// EPIC E3 - Inventory: stock levels, movements, and the reservation rules
// that stop us selling the same unit twice.
import { Router } from 'express';
import { db, audit } from '../db.js';
import { requireAuth, requireRole, actorId } from '../auth.js';

const r = Router();

const WAREHOUSE = ['warehouse', 'merchandiser', 'admin'];

/**
 * Reserve `qty` of a variant for an order.
 *
 * The whole oversell problem is solved by making the guard part of the UPDATE
 * rather than a SELECT that a concurrent request can race past. `available` is
 * on_hand - reserved, so the WHERE clause re-checks availability at the moment
 * of the write. Two simultaneous orders for the last unit: the first changes a
 * row, the second changes nothing and is told to back off.
 *
 * @returns {boolean} true if the reservation was taken
 */
export function reserveStock(variantId, qty) {
  const info = db.prepare(`
    UPDATE stock_levels SET reserved = reserved + ?
     WHERE variant_id = ? AND (on_hand - reserved) >= ?
  `).run(qty, variantId, qty);
  return info.changes > 0;
}

/** Give a reservation back (order cancelled, or payment failed). */
export function releaseStock(variantId, qty) {
  db.prepare('UPDATE stock_levels SET reserved = MAX(reserved - ?, 0) WHERE variant_id = ?')
    .run(qty, variantId);
}

/** Turn a reservation into a real decrement - the moment the goods leave. */
export function commitStock(variantId, qty) {
  db.prepare(`
    UPDATE stock_levels
       SET on_hand = MAX(on_hand - ?, 0),
           reserved = MAX(reserved - ?, 0)
     WHERE variant_id = ?
  `).run(qty, qty, variantId);
}

function recordMovement(variantId, delta, reason, refType, refId, actor) {
  db.prepare(`
    INSERT INTO stock_movements (variant_id, delta, reason, ref_type, ref_id, actor_id)
    VALUES (?,?,?,?,?,?)
  `).run(variantId, delta, reason, refType ?? null, refId ?? null, actor ?? null);
}

// ------------------------------------------------------------------ reading
r.get('/inventory', requireAuth, requireRole(...WAREHOUSE), (req, res) => {
  const rows = db.prepare(`
    SELECT v.id AS variant_id, v.sku, v.name AS variant_name, v.price_paise,
           p.name AS product_name, p.slug AS product_slug,
           s.on_hand, s.reserved, (s.on_hand - s.reserved) AS available, s.reorder_point
      FROM stock_levels s
      JOIN variants v ON v.id = s.variant_id
      JOIN products p ON p.id = v.product_id
     ORDER BY (s.on_hand - s.reserved) ASC, v.sku
     LIMIT 500
  `).all();
  res.json({ data: rows, summary: {
    skus: rows.length,
    total_on_hand: rows.reduce((s, x) => s + x.on_hand, 0),
    total_reserved: rows.reduce((s, x) => s + x.reserved, 0),
    low_stock: rows.filter((x) => x.available <= x.reorder_point).length,
  } });
});

/** US-3.4 Anything at or below its reorder point. */
r.get('/inventory/low-stock', requireAuth, requireRole(...WAREHOUSE), (_req, res) => {
  res.json({ data: db.prepare(`
      SELECT v.sku, p.name AS product_name, s.on_hand, s.reserved,
             (s.on_hand - s.reserved) AS available, s.reorder_point
        FROM stock_levels s
        JOIN variants v ON v.id = s.variant_id
        JOIN products p ON p.id = v.product_id
       WHERE (s.on_hand - s.reserved) <= s.reorder_point
       ORDER BY available ASC
  `).all() });
});

/** US-3.5 Every movement, with the reason and the thing that caused it. */
r.get('/inventory/movements', requireAuth, requireRole(...WAREHOUSE), (req, res) => {
  const { sku, limit = '100' } = req.query;
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const data = sku
    ? db.prepare(`
        SELECT m.*, v.sku FROM stock_movements m
          JOIN variants v ON v.id = m.variant_id
         WHERE v.sku = ? ORDER BY m.id DESC LIMIT ?`).all(sku, cap)
    : db.prepare(`
        SELECT m.*, v.sku FROM stock_movements m
          JOIN variants v ON v.id = m.variant_id
         ORDER BY m.id DESC LIMIT ?`).all(cap);
  res.json({ data });
});

// ------------------------------------------------------------------- writes
/** US-3.2 Receive stock against a purchase / delivery. Only ever adds. */
r.post('/admin/inventory/:variantId/receive', requireAuth, requireRole('warehouse', 'admin'), (req, res) => {
  const v = db.prepare('SELECT * FROM variants WHERE id = ?').get(req.params.variantId);
  if (!v) return res.status(404).json({ error: 'variant not found' });
  const { qty, reason = 'goods_received', reference = '' } = req.body || {};
  const n = Number(qty);
  if (!Number.isInteger(n) || n <= 0) {
    return res.status(400).json({ error: 'qty must be a positive integer' });
  }
  db.prepare('UPDATE stock_levels SET on_hand = on_hand + ? WHERE variant_id = ?').run(n, v.id);
  recordMovement(v.id, n, reason, 'receipt', null, actorId(req));
  audit(actorId(req), 'variant', v.id, 'stock.received', { qty: n, reference });
  res.json({ data: db.prepare('SELECT * FROM stock_levels WHERE variant_id = ?').get(v.id) });
});

/**
 * US-3.3 Correct the on-hand count (stocktake, damage, loss).
 * This can go negative in `delta` terms but on_hand itself is clamped at 0 by
 * the schema CHECK, so a bad count cannot invent inventory.
 */
r.patch('/admin/inventory/:variantId', requireAuth, requireRole('warehouse', 'admin'), (req, res) => {
  const v = db.prepare('SELECT * FROM variants WHERE id = ?').get(req.params.variantId);
  if (!v) return res.status(404).json({ error: 'variant not found' });
  const level = db.prepare('SELECT * FROM stock_levels WHERE variant_id = ?').get(v.id);
  if (!level) return res.status(404).json({ error: 'no stock level for this variant' });

  const { on_hand, reorder_point, reason = 'stocktake_adjustment' } = req.body || {};
  if (on_hand === undefined && reorder_point === undefined) {
    return res.status(400).json({ error: 'on_hand or reorder_point is required' });
  }
  if (on_hand !== undefined) {
    const n = Number(on_hand);
    if (!Number.isInteger(n) || n < 0) {
      return res.status(400).json({ error: 'on_hand must be a non-negative integer' });
    }
    if (n < level.reserved) {
      // Silently letting on_hand drop below what is already reserved would make
      // the availability figure a lie.
      return res.status(422).json({
        error: 'on_hand cannot be below the reserved quantity',
        reserved: level.reserved,
        requested: n,
      });
    }
    const delta = n - level.on_hand;
    db.prepare('UPDATE stock_levels SET on_hand = ? WHERE variant_id = ?').run(n, v.id);
    if (delta !== 0) recordMovement(v.id, delta, reason, 'adjustment', null, actorId(req));
    audit(actorId(req), 'variant', v.id, 'stock.adjusted', { from: level.on_hand, to: n, reason });
  }
  if (reorder_point !== undefined) {
    const rp = Number(reorder_point);
    if (!Number.isInteger(rp) || rp < 0) {
      return res.status(400).json({ error: 'reorder_point must be a non-negative integer' });
    }
    db.prepare('UPDATE stock_levels SET reorder_point = ? WHERE variant_id = ?').run(rp, v.id);
  }
  res.json({ data: db.prepare('SELECT * FROM stock_levels WHERE variant_id = ?').get(v.id) });
});

export default r;
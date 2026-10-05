// EPIC E7 - Reporting and audit: one dashboard per role, and a ledger you can
// check every write against.
import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireRole, actorId } from '../auth.js';
import { formatINR } from '../money.js';

const r = Router();

const STAFF = ['agent', 'warehouse', 'finance', 'merchandiser', 'admin'];

/**
 * US-7.1 The landing page for whichever role is signed in.
 *
 * Each role gets numbers it can act on. A single "all metrics for everyone"
 * dashboard would be noise: the warehouse cares about low stock and open picks,
 * finance cares about settlement, nobody else does.
 */
r.get('/dashboard', requireAuth, (req, res) => {
  const role = req.user.role;
  const me = actorId(req);
  const one = (sql, ...a) => db.prepare(sql).get(...a);

  const base = {
    role,
    user: one('SELECT id, name, email, role FROM users WHERE id = ?', me),
    unread_notifications: one(
      'SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', me).n,
  };

  if (role === 'customer') {
    const orders = one('SELECT COUNT(*) AS n FROM orders WHERE customer_id = ?', me).n;
    const spend = one(
      "SELECT COALESCE(SUM(total_paise),0) AS n FROM orders WHERE customer_id = ? AND status <> 'cancelled'", me).n;
    return res.json({
      ...base,
      cards: [
        { label: 'Orders placed', value: orders },
        { label: 'Lifetime spend', value: spend, display: formatINR(spend) },
        { label: 'Cart items', value: one("SELECT COALESCE(SUM(ci.qty),0) AS n FROM cart_items ci JOIN carts c ON c.id = ci.cart_id WHERE c.user_id = ? AND c.status = 'open'", me).n },
        { label: 'Open returns', value: one("SELECT COUNT(*) AS n FROM returns WHERE customer_id = ? AND status NOT IN ('refunded','rejected')", me).n },
      ],
      recent_orders: db.prepare(
        'SELECT id, code, status, total_paise, placed_at FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 5').all(me),
    });
  }

  const revenue = one(
    "SELECT COALESCE(SUM(total_paise),0) AS n FROM orders WHERE status IN ('paid','picking','packed','shipped','delivered')").n;

  const staffCards = {
    warehouse: [
      { label: 'SKUs tracked', value: one('SELECT COUNT(*) AS n FROM stock_levels').n },
      { label: 'Units on hand', value: one('SELECT COALESCE(SUM(on_hand),0) AS n FROM stock_levels').n },
      { label: 'Units reserved', value: one('SELECT COALESCE(SUM(reserved),0) AS n FROM stock_levels').n },
      { label: 'Below reorder point', value: one('SELECT COUNT(*) AS n FROM stock_levels WHERE (on_hand - reserved) <= reorder_point').n },
      { label: 'Packed, awaiting dispatch', value: one("SELECT COUNT(*) AS n FROM orders WHERE status = 'packed'").n },
    ],
    finance: [
      { label: 'Gross captured', value: revenue, display: formatINR(revenue) },
      { label: 'Refunded', value: one("SELECT COALESCE(SUM(amount_paise),0) AS n FROM refunds WHERE status = 'paid'").n, display: formatINR(one("SELECT COALESCE(SUM(amount_paise),0) AS n FROM refunds WHERE status = 'paid'").n) },
      { label: 'Failed attempts', value: one("SELECT COUNT(*) AS n FROM payments WHERE status = 'failed'").n },
      { label: 'Open returns', value: one("SELECT COUNT(*) AS n FROM returns WHERE status IN ('requested','approved','received')").n },
    ],
    agent: [
      { label: 'Orders needing action', value: one("SELECT COUNT(*) AS n FROM orders WHERE status IN ('placed','paid','picking')").n },
      { label: 'Open returns', value: one("SELECT COUNT(*) AS n FROM returns WHERE status IN ('requested','approved')").n },
      { label: 'In transit', value: one("SELECT COUNT(*) AS n FROM shipments WHERE status <> 'delivered'").n },
      { label: 'Delivered today', value: one("SELECT COUNT(*) AS n FROM shipments WHERE date(delivered_at) = date('now')").n },
    ],
    merchandiser: [
      { label: 'Active products', value: one("SELECT COUNT(*) AS n FROM products WHERE status = 'active'").n },
      { label: 'Draft products', value: one("SELECT COUNT(*) AS n FROM products WHERE status = 'draft'").n },
      { label: 'SKUs live', value: one('SELECT COUNT(*) AS n FROM variants WHERE active = 1').n },
      { label: 'Out of stock SKUs', value: one('SELECT COUNT(*) AS n FROM stock_levels WHERE (on_hand - reserved) <= 0').n },
    ],
    admin: [
      { label: 'Users', value: one('SELECT COUNT(*) AS n FROM users').n },
      { label: 'Orders', value: one('SELECT COUNT(*) AS n FROM orders').n },
      { label: 'Gross captured', value: revenue, display: formatINR(revenue) },
      { label: 'Audit events', value: one('SELECT COUNT(*) AS n FROM audit_events').n },
    ],
  };

  res.json({
    ...base,
    cards: staffCards[role] ?? staffCards.admin,
    recent_orders: db.prepare(
      `SELECT id, code, status, total_paise, placed_at FROM orders ORDER BY id DESC LIMIT 5`).all(),
  });
});

/** US-7.2 Revenue by day and by status, in paise. */
r.get('/insights/revenue', requireAuth, requireRole(...STAFF), (req, res) => {
  const byDay = db.prepare(`
    SELECT date(placed_at) AS day,
           COUNT(*) AS orders,
           COALESCE(SUM(total_paise), 0) AS gross_paise,
           COALESCE(SUM(CASE WHEN status = 'cancelled' THEN total_paise ELSE 0 END), 0) AS cancelled_paise
      FROM orders GROUP BY day ORDER BY day DESC LIMIT 30`).all();
  const byStatus = db.prepare('SELECT status, COUNT(*) AS orders, COALESCE(SUM(total_paise),0) AS gross_paise FROM orders GROUP BY status').all();
  const lifetime = db.prepare(
    "SELECT COALESCE(SUM(total_paise),0) AS n FROM orders WHERE status <> 'cancelled'").get().n;
  res.json({
    by_day: byDay.map((d) => ({ ...d, gross_display: formatINR(d.gross_paise) })),
    by_status: byStatus.map((s) => ({ ...s, gross_display: formatINR(s.gross_paise) })),
    lifetime_paise: lifetime,
    lifetime_display: formatINR(lifetime),
  });
});

/** US-7.3 Best sellers by units and by revenue. */
r.get('/insights/top-products', requireAuth, requireRole(...STAFF), (req, res) => {
  const { limit = '10' } = req.query;
  const cap = Math.min(Math.max(Number(limit) || 10, 1), 50);
  const rows = db.prepare(`
    SELECT oi.sku, oi.name, p.slug AS product_slug,
           SUM(oi.qty) AS units,
           SUM(oi.line_total_paise) AS revenue_paise
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      JOIN products p ON p.id = (SELECT product_id FROM variants WHERE id = oi.variant_id)
     WHERE o.status <> 'cancelled'
     GROUP BY oi.sku, oi.name, p.slug
     ORDER BY units DESC LIMIT ?`).all(cap);
  res.json({ data: rows.map((x) => ({ ...x, revenue_display: formatINR(x.revenue_paise) })) });
});

/** US-7.4 The audit ledger, filterable by entity or actor. */
r.get('/audit', requireAuth, requireRole('admin'), (req, res) => {
  const { entity, actor_id, limit = '100' } = req.query;
  const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const where = [];
  const params = {};
  if (entity) { where.push('a.entity = :entity'); params.entity = entity; }
  if (actor_id) { where.push('a.actor_id = :actor_id'); params.actor_id = Number(actor_id); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const data = db.prepare(`
    SELECT a.*, u.name AS actor_name, u.role AS actor_role
      FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
      ${clause} ORDER BY a.id DESC LIMIT :limit`).all({ ...params, limit: cap });
  res.json({ data });
});

export default r;
// EPIC E6 - Fulfilment: labels, dispatch, tracking.
//
// Dispatch is the moment stock stops being reserved and starts being gone, so
// it is the only place commitStock() is called.
import { Router } from 'express';
import { db, audit, notify } from '../db.js';
import { requireAuth, requireRole, actorId } from '../auth.js';
import { commitStock } from './inventory.js';
import { ORDER_FLOW } from './orders.js';

const r = Router();

const FULFIL = ['warehouse', 'agent', 'admin'];
const STAFF = ['agent', 'warehouse', 'finance', 'admin'];

const SHIPMENT_FLOW = {
  label_created:    ['in_transit'],
  in_transit:       ['out_for_delivery', 'delivered'],
  out_for_delivery: ['delivered'],
  delivered:        [],
};

/**
 * US-6.2 Dispatch a packed order.
 *
 * Requires `packed`, not `paid`: a packed order is the one whose lines are
 * already reserved and physically in hand. Committing here, and only here, is
 * what keeps on_hand and reserved from drifting apart.
 */
r.post('/admin/orders/:id/ship', requireAuth, requireRole(...FULFIL), (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'order not found' });
  // The "already dispatched" check comes first: for a re-dispatch attempt it is
  // the more precise diagnosis, and "illegal transition shipped -> shipped"
  // would send the operator looking at the state machine instead of the real
  // cause.
  if (db.prepare('SELECT id FROM shipments WHERE order_id = ?').get(o.id)) {
    return res.status(409).json({ error: 'order already has a shipment' });
  }
  if (!ORDER_FLOW[o.status].includes('shipped')) {
    return res.status(422).json({ error: `illegal transition ${o.status} -> shipped`, allowed: ORDER_FLOW[o.status] });
  }
  const { carrier, tracking_no } = req.body || {};
  if (!carrier || !tracking_no) {
    return res.status(400).json({ error: 'carrier and tracking_no are required' });
  }
  if (db.prepare('SELECT id FROM shipments WHERE tracking_no = ?').get(tracking_no)) {
    return res.status(409).json({ error: 'tracking_no already used' });
  }

  const shipmentId = db.transaction(() => {
    for (const line of db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(o.id)) {
      commitStock(line.variant_id, line.qty);
      db.prepare(`INSERT INTO stock_movements (variant_id, delta, reason, ref_type, ref_id, actor_id)
                  VALUES (?,?,?,?,?,?)`)
        .run(line.variant_id, -line.qty, 'dispatched', 'order', o.id, actorId(req));
    }
    const id = db.prepare(
      "INSERT INTO shipments (order_id, carrier, tracking_no, status, shipped_at) VALUES (?,?,?,'label_created',datetime('now'))"
    ).run(o.id, carrier, tracking_no).lastInsertRowid;
    db.prepare(`INSERT INTO shipment_events (shipment_id, status, location, note) VALUES (?,?,?,?)`)
      .run(id, 'label_created', carrier, 'Label created');
    db.prepare("UPDATE orders SET status = 'shipped', updated_at = datetime('now') WHERE id = ?").run(o.id);
    return id;
  })();

  audit(actorId(req), 'shipment', shipmentId, 'shipment.dispatched', { order: o.code, carrier, tracking_no });
  notify(o.customer_id, 'order_shipped', `Order ${o.code} shipped on ${carrier}. Tracking ${tracking_no}.`);
  res.status(201).json({ data: db.prepare('SELECT * FROM shipments WHERE id = ?').get(shipmentId) });
});

/** US-6.3 Post a tracking event. Delivery is what closes the order. */
r.post('/shipments/:id/events', requireAuth, requireRole(...FULFIL), (req, res) => {
  const s = db.prepare('SELECT * FROM shipments WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'shipment not found' });
  const { status, location = '', note = '' } = req.body || {};
  if (!SHIPMENT_FLOW[s.status]?.includes(status)) {
    return res.status(422).json({
      error: `illegal transition ${s.status} -> ${status}`, allowed: SHIPMENT_FLOW[s.status],
    });
  }

  db.transaction(() => {
    db.prepare('UPDATE shipments SET status = ? WHERE id = ?').run(status, s.id);
    db.prepare('INSERT INTO shipment_events (shipment_id, status, location, note) VALUES (?,?,?,?)')
      .run(s.id, status, location, note);
    if (status === 'delivered') {
      db.prepare("UPDATE shipments SET delivered_at = datetime('now') WHERE id = ?").run(s.id);
      const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(s.order_id);
      if (ORDER_FLOW[o.status].includes('delivered')) {
        db.prepare("UPDATE orders SET status = 'delivered', updated_at = datetime('now') WHERE id = ?").run(o.id);
        notify(o.customer_id, 'order_delivered', `Order ${o.code} delivered. Returns are open for 7 days.`);
      }
    }
  })();

  audit(actorId(req), 'shipment', s.id, 'shipment.event', { status });
  res.json({
    data: db.prepare('SELECT * FROM shipments WHERE id = ?').get(s.id),
    events: db.prepare('SELECT * FROM shipment_events WHERE shipment_id = ? ORDER BY id').all(s.id),
  });
});

r.get('/shipments', requireAuth, (req, res) => {
  const rows = STAFF.includes(req.user.role)
    ? db.prepare(`SELECT sh.*, o.code AS order_code FROM shipments sh JOIN orders o ON o.id = sh.order_id ORDER BY sh.id DESC LIMIT 200`).all()
    : db.prepare(`SELECT sh.*, o.code AS order_code FROM shipments sh JOIN orders o ON o.id = sh.order_id
                   WHERE o.customer_id = ? ORDER BY sh.id DESC LIMIT 200`).all(actorId(req));
  res.json({ data: rows });
});

r.get('/shipments/:id', requireAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM shipments WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'shipment not found' });
  const o = db.prepare('SELECT customer_id, code FROM orders WHERE id = ?').get(s.order_id);
  if (!STAFF.includes(req.user.role) && o.customer_id !== actorId(req)) {
    return res.status(403).json({ error: 'forbidden', required_roles: STAFF, your_role: req.user.role });
  }
  res.json({
    data: s,
    order_code: o.code,
    events: db.prepare('SELECT * FROM shipment_events WHERE shipment_id = ? ORDER BY id').all(s.id),
  });
});

export default r;
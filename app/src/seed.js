// ShopHub - demo data.
//
// Seeded only when DB_SEED=true (or AUTO_SEED), so a production database is
// never populated with demo accounts by accident. Every password is the same
// documented demo password because these are throwaway fixtures.
import { db, audit, notify } from './db.js';
import { hashPassword } from './auth.js';
import { totalsFor } from './money.js';
import { reserveStock, commitStock, releaseStock } from './routes/inventory.js';
import { charge } from './gateway.js';

export const DEMO_PASSWORD = 'Passw0rd!';

const P = DEMO_PASSWORD;

const CATEGORIES = [
  ['audio', 'Audio'], ['wearables', 'Wearables'], ['computing', 'Computing'],
  ['kitchen', 'Kitchen'], ['outdoor', 'Outdoor'],
];

// [slug, name, category_slug, brand, description, [[sku, variant name, price_paise, opening_stock]]]
const PRODUCTS = [
  ['aurora-headphones', 'Aurora Wireless Headphones', 'audio', 'Aurora',
    'Over-ear ANC headphones with 40h battery.',
    [['AUR-ANC-01', 'Midnight black', 249900, 18], ['AUR-ANC-02', 'Sand', 249900, 9]]],
  ['pulse-buds', 'Pulse True Wireless Earbuds', 'audio', 'Aurora',
    'Compact buds, 24h case battery, IPX5.',
    [['PLS-TWS-01', 'Black', 79900, 25]]],
  ['stride-band', 'Stride Fitness Band', 'wearables', 'Stride',
    'AMOLED band with SpO2 and 14-day battery.',
    [['STR-BND-01', 'Charcoal', 349900, 30], ['STR-BND-02', 'Coral', 349900, 14]]],
  ['meridian-smartwatch', 'Meridian Smartwatch', 'wearables', 'Meridian',
    'GPS smartwatch, always-on display, 7-day battery.',
    [['MER-SW-01', 'Titanium', 1999900, 11], ['MER-SW-02', 'Graphite', 1799900, 6]]],
  ['lumen-lamp', 'Lumen Smart Lamp', 'kitchen', 'Lumen',
    'Tunable white smart lamp with scene presets.',
    [['LUM-LMP-01', 'Warm white', 249900, 22]]],
  ['terra-mug', 'Terra Insulated Mug', 'kitchen', 'Terra',
    'Double-wall steel mug, 400ml, keeps warm 6h.',
    [['TER-MUG-01', 'Stone 400ml', 89900, 80], ['TER-MUG-02', 'Clay 400ml', 89900, 60]]],
  ['nomad-torch', 'Nomad Rechargeable Torch', 'outdoor', 'Nomad',
    '900-lumen torch with power bank output.',
    [['NOM-TOR-01', 'Standard', 199900, 16], ['NOM-TOR-02', 'Tactical', 249900, 4]]],
  ['summit-pack', 'Summit 28L Daypack', 'outdoor', 'Summit',
    'Water-resistant daypack with padded laptop sleeve.',
    [['SMT-PK-28', '28L Slate', 349900, 12]]],
  ['vertex-keyboard', 'Vertex Mechanical Keyboard', 'computing', 'Vertex',
    'Hot-swappable 75% mechanical keyboard.',
    [['VTX-KB-75', 'Brown switches', 499900, 10]]],
  ['orbit-mouse', 'Orbit Ergonomic Mouse', 'computing', 'Orbit',
    'Silent-click vertical mouse, USB-C.',
    [['ORB-MS-01', 'Graphite', 199900, 26], ['ORB-MS-02', 'Ivory', 199900, 20]]],
];

const USERS = [
  ['Aarav Sharma', 'aarav@shop.test', 'customer'],
  ['Diya Patel', 'diya@shop.test', 'customer'],
  ['Ishaan Rao', 'ishaan@shop.test', 'customer'],
  ['Kavya Menon', 'kavya@shop.test', 'customer'],
  ['Rohan Kulkarni', 'rohan@shop.test', 'customer'],
  ['Neha Verma', 'neha@shop.test', 'agent'],
  ['Vikram Singh', 'vikram@shop.test', 'warehouse'],
  ['Priya Nair', 'priya@shop.test', 'merchandiser'],
  ['Anil Gupta', 'anil@shop.test', 'finance'],
  ['Admin User', 'admin@shop.test', 'admin'],
];

const ADDRESSES = [
  ['Aarav Sharma', 'Home', '12 Nehru Road', 'Pune', '411001', 1],
  ['Diya Patel', 'Home', '48 MG Road', 'Bengaluru', '560001', 1],
  ['Ishaan Rao', 'Hostel', '7 University Lane', 'Pune', '411007', 1],
  ['Kavya Menon', 'Home', '301 Residency Road', 'Hyderabad', '500002', 1],
  ['Rohan Kulkarni', 'Office', '22 Baner Road', 'Pune', '411045', 1],
];

export function seed() {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (existing > 0) return { seeded: false };

  const hash = hashPassword(P);

  const tx = db.transaction(() => {
    // categories ------------------------------------------------------------
    for (const [slug, name] of CATEGORIES) {
      db.prepare('INSERT INTO categories (slug, name) VALUES (?,?)').run(slug, name);
    }

    // users -----------------------------------------------------------------
    const userId = {};
    for (const [name, email, role] of USERS) {
      const id = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)')
        .run(name, email, hash, role).lastInsertRowid;
      userId[role] ??= [];
      userId[role].push(id);
    }

    // addresses -------------------------------------------------------------
    for (const [name, label, line1, city, pincode, isDefault] of ADDRESSES) {
      const u = db.prepare('SELECT id FROM users WHERE name = ?').get(name);
      db.prepare('INSERT INTO addresses (user_id, label, line1, city, pincode, is_default) VALUES (?,?,?,?,?,?)')
        .run(u.id, label, line1, city, pincode, isDefault);
    }

    // catalogue + stock -----------------------------------------------------
    const variantBySku = {};
    for (const [slug, name, catSlug, brand, description, variants] of PRODUCTS) {
      const cat = db.prepare('SELECT id FROM categories WHERE slug = ?').get(catSlug);
      const pid = db.prepare(
        'INSERT INTO products (slug, name, category_id, brand, description, status) VALUES (?,?,?,?,?,\'active\')'
      ).run(slug, name, cat.id, brand, description).lastInsertRowid;
      for (const [sku, vName, price, opening] of variants) {
        const vid = db.prepare('INSERT INTO variants (product_id, sku, name, price_paise) VALUES (?,?,?,?)')
          .run(pid, sku, vName, price).lastInsertRowid;
        db.prepare('INSERT INTO stock_levels (variant_id, on_hand, reserved, reorder_point) VALUES (?,?,0,5)')
          .run(vid, opening);
        if (opening > 0) {
          db.prepare(`INSERT INTO stock_movements (variant_id, delta, reason, ref_type, ref_id, actor_id)
                      VALUES (?,?,'opening_stock','product',?,NULL)`)
            .run(vid, opening, pid);
        }
        variantBySku[sku] = vid;
      }
    }

    // one SKU deliberately parked below its reorder point so the low-stock
    // report has something real to show rather than an empty table
    db.prepare('UPDATE stock_levels SET reorder_point = 8 WHERE variant_id = ?')
      .run(variantBySku['NOM-TOR-02']);

    return { userId, variantBySku };
  });
  const { userId, variantBySku } = tx();

  for (const role of Object.keys(userId)) {
    for (const id of userId[role]) notify(id, 'welcome', `Welcome to ShopHub. Demo account (${role}).`);
  }

  // A handful of orders spread across the lifecycle, so every screen has data.
  const customers = userId.customer;
  const plans = [
    { skus: [['AUR-ANC-01', 1], ['TER-MUG-01', 2]], pay: true, advance: 'shipped' },
    { skus: [['MER-SW-02', 1]], pay: true, advance: 'delivered' },
    { skus: [['PLS-TWS-01', 2], ['ORB-MS-01', 1]], pay: true, advance: 'delivered' },
    { skus: [['VTX-KB-75', 1]], pay: true, advance: 'picking' },
    { skus: [['STR-BND-01', 1], ['NOM-TOR-01', 1]], pay: false, advance: null },
    { skus: [['SMT-PK-28', 1]], pay: true, advance: 'packed' },
  ];

  plans.forEach((plan, idx) => {
    const customerId = customers[idx % customers.length];
    const lines = plan.skus.map(([sku, qty]) => {
      const v = db.prepare('SELECT id, sku, name, price_paise FROM variants WHERE sku = ?').get(sku);
      return { variant_id: v.id, sku: v.sku, name: v.name, qty, unit_price_paise: v.price_paise };
    });

    const reserved = lines.every((l) => reserveStock(l.variant_id, l.qty));
    if (!reserved) {
      lines.forEach((l) => releaseStock(l.variant_id, l.qty));
      return;
    }

    const address = db.prepare(
      'SELECT label, line1, city, pincode FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id LIMIT 1').get(customerId);
    const totals = totalsFor(lines, 0);
    const nextId = db.prepare('SELECT COALESCE(MAX(id),0)+1 AS n FROM orders').get().n;
    const code = `SH-${10000 + nextId}`;

    const orderId = db.prepare(`
      INSERT INTO orders (code, customer_id, status, subtotal_paise, discount_paise,
                          tax_paise, shipping_paise, total_paise, ship_to)
      VALUES (?,?,'created',?,?,?,?,?,?)`)
      .run(code, customerId, totals.subtotal_paise, totals.discount_paise, totals.tax_paise,
        totals.shipping_paise, totals.total_paise,
        JSON.stringify({ label: address.label, line1: address.line1, city: address.city, pincode: address.pincode }))
      .lastInsertRowid;

    for (const l of lines) {
      db.prepare(`INSERT INTO order_items (order_id, variant_id, sku, name, qty, unit_price_paise, line_total_paise)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(orderId, l.variant_id, l.sku, l.name, l.qty, l.unit_price_paise, l.qty * l.unit_price_paise);
    }

    if (!plan.pay) return; // stays in `created`, awaiting payment

    const result = charge({
      amount_paise: totals.total_paise, method: 'card',
      card_number: '4242424242424242', idempotency_key: `seed-${code}-${idx}`,
    });
    db.prepare(`INSERT INTO payments (order_id, amount_paise, method, status, idempotency_key, receipt_no)
                VALUES (?,?,'card','captured',?,?)`)
      .run(orderId, totals.total_paise, `seed-${code}-${idx}`, result.receipt_no);
    db.prepare("UPDATE orders SET status = 'paid' WHERE id = ?").run(orderId);

    const path = { shipped: ['picking', 'packed', 'shipped'], delivered: ['picking', 'packed', 'shipped', 'delivered'], picking: ['picking'], packed: ['picking', 'packed'] }[plan.advance];
    if (!path) return;

    for (const step of path) {
      db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(step, orderId);
    }

    if (plan.advance === 'shipped' || plan.advance === 'delivered') {
      const tracking = `TRK${100000 + orderId}`;
      const shipmentId = db.prepare(`
        INSERT INTO shipments (order_id, carrier, tracking_no, status, shipped_at, delivered_at)
        VALUES (?,?,?,?,datetime('now'),?)`)
        .run(orderId, ['Delhivery', 'BlueDart', 'Ecom Express'][orderId % 3], tracking,
          plan.advance === 'delivered' ? 'delivered' : 'in_transit',
          plan.advance === 'delivered' ? '2026-10-04 11:20:00' : null).lastInsertRowid;
      for (const line of lines) {
        commitStock(line.variant_id, line.qty);
        db.prepare(`INSERT INTO stock_movements (variant_id, delta, reason, ref_type, ref_id, actor_id)
                    VALUES (?,?,'dispatched','order',?,?)`)
          .run(line.variant_id, -line.qty, orderId, userId.warehouse[0]);
      }
      for (const st of plan.advance === 'delivered' ? ['label_created', 'in_transit', 'out_for_delivery', 'delivered'] : ['label_created', 'in_transit']) {
        db.prepare('INSERT INTO shipment_events (shipment_id, status, location, note) VALUES (?,?,?,?)')
          .run(shipmentId, st, st === 'delivered' ? 'Pune' : 'Hub', st.replace(/_/g, ' '));
      }
      notify(customerId, 'order_shipped', `Order ${code} shipped. Tracking ${tracking}.`);
    }

    if (plan.advance === 'delivered') {
      const item = db.prepare('SELECT id FROM order_items WHERE order_id = ? LIMIT 1').get(orderId);
      db.prepare(`INSERT INTO returns (order_id, order_item_id, customer_id, qty, reason, status)
                  VALUES (?,?,?,?,?, 'approved')`)
        .run(orderId, item.id, customerId, 1, 'arrived damaged');
    }

    audit(customerId, 'order', orderId, 'order.placed', { code, seed: true });
  });

  audit(null, 'system', 0, 'system.seeded', { products: PRODUCTS.length, orders: plans.length });
  return { seeded: true };
}

export function maybeSeed() {
  if (process.env.AUTO_SEED === 'true' || process.env.DB_SEED === 'true') return seed();
  return { seeded: false };
}
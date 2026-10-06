// ShopHub - data layer (SQLite / better-sqlite3).
//
// This is the ONLY file that knows which database engine we are talking to.
// Every route uses the two helpers exported here, so moving to PostgreSQL is a
// single-file change rather than a rewrite.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'shop.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function migrate() {
  db.exec(`
    -- E1 Identity -------------------------------------------------------
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL,
      email         TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      role          TEXT    NOT NULL CHECK (role IN
                      ('customer','agent','warehouse','merchandiser','finance','admin')),
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS addresses (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label      TEXT    NOT NULL,
      line1      TEXT    NOT NULL,
      city       TEXT    NOT NULL,
      pincode    TEXT    NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0
    );

    -- E2 Catalogue ------------------------------------------------------
    CREATE TABLE IF NOT EXISTS categories (
      id   INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      slug        TEXT    NOT NULL UNIQUE,
      name        TEXT    NOT NULL,
      category_id INTEGER NOT NULL REFERENCES categories(id),
      brand       TEXT    NOT NULL DEFAULT '',
      description TEXT    NOT NULL DEFAULT '',
      status      TEXT    NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','active','archived')),
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- A SKU is a variant: the thing with a price and a stock level.
    CREATE TABLE IF NOT EXISTS variants (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      sku          TEXT    NOT NULL UNIQUE,
      name         TEXT    NOT NULL,
      price_paise  INTEGER NOT NULL CHECK (price_paise >= 0),
      active       INTEGER NOT NULL DEFAULT 1
    );

    -- E3 Inventory ------------------------------------------------------
    -- on_hand is physical, reserved is committed to orders not yet shipped.
    -- Available = on_hand - reserved, and available is what we sell.
    CREATE TABLE IF NOT EXISTS stock_levels (
      variant_id   INTEGER PRIMARY KEY REFERENCES variants(id),
      on_hand      INTEGER NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
      reserved     INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
      reorder_point INTEGER NOT NULL DEFAULT 5
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      variant_id INTEGER NOT NULL REFERENCES variants(id),
      delta      INTEGER NOT NULL,
      reason     TEXT    NOT NULL,
      ref_type   TEXT,
      ref_id     INTEGER,
      actor_id   INTEGER REFERENCES users(id),
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- E4 Cart & Orders --------------------------------------------------
    CREATE TABLE IF NOT EXISTS carts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status     TEXT    NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','converted','abandoned')),
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cart_items (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      cart_id         INTEGER NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
      variant_id      INTEGER NOT NULL REFERENCES variants(id),
      qty             INTEGER NOT NULL CHECK (qty > 0),
      unit_price_paise INTEGER NOT NULL,
      UNIQUE (cart_id, variant_id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      code           TEXT    NOT NULL UNIQUE,
      customer_id    INTEGER NOT NULL REFERENCES users(id),
      status         TEXT    NOT NULL DEFAULT 'created'
                     CHECK (status IN ('created','paid','picking','packed','shipped','delivered','cancelled')),
      subtotal_paise INTEGER NOT NULL,
      discount_paise INTEGER NOT NULL DEFAULT 0,
      tax_paise      INTEGER NOT NULL,
      shipping_paise INTEGER NOT NULL DEFAULT 0,
      total_paise    INTEGER NOT NULL,
      ship_to        TEXT    NOT NULL,
      cancel_reason  TEXT,
      placed_at      TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Line detail is snapshotted, not joined: a price change tomorrow must not
    -- rewrite what the customer was charged yesterday.
    CREATE TABLE IF NOT EXISTS order_items (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      variant_id       INTEGER NOT NULL REFERENCES variants(id),
      sku              TEXT    NOT NULL,
      name             TEXT    NOT NULL,
      qty              INTEGER NOT NULL CHECK (qty > 0),
      unit_price_paise INTEGER NOT NULL,
      line_total_paise INTEGER NOT NULL
    );

    -- E5 Payments & Returns ---------------------------------------------
    CREATE TABLE IF NOT EXISTS payments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id        INTEGER NOT NULL REFERENCES orders(id),
      amount_paise    INTEGER NOT NULL CHECK (amount_paise > 0),
      method          TEXT    NOT NULL CHECK (method IN ('card','upi','netbanking','wallet')),
      status          TEXT    NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','captured','failed','refunded')),
      idempotency_key TEXT    NOT NULL UNIQUE,
      receipt_no      TEXT,
      failure_reason  TEXT,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS returns (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id      INTEGER NOT NULL REFERENCES orders(id),
      order_item_id INTEGER NOT NULL REFERENCES order_items(id),
      customer_id   INTEGER NOT NULL REFERENCES users(id),
      qty           INTEGER NOT NULL CHECK (qty > 0),
      reason        TEXT    NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'requested'
                    CHECK (status IN ('requested','approved','in_transit','received','refunded','rejected')),
      created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS refunds (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      -- nullable: a refund can come from a return OR from an order cancellation
      return_id   INTEGER REFERENCES returns(id),
      order_id    INTEGER NOT NULL REFERENCES orders(id),
      payment_id  INTEGER NOT NULL REFERENCES payments(id),
      amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
      status      TEXT    NOT NULL DEFAULT 'requested'
                  CHECK (status IN ('requested','approved','paid')),
      reason      TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- E6 Fulfilment -----------------------------------------------------
    CREATE TABLE IF NOT EXISTS shipments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id    INTEGER NOT NULL UNIQUE REFERENCES orders(id),
      carrier     TEXT    NOT NULL,
      tracking_no TEXT    NOT NULL UNIQUE,
      status      TEXT    NOT NULL DEFAULT 'label_created'
                  CHECK (status IN ('label_created','in_transit','out_for_delivery','delivered')),
      shipped_at  TEXT,
      delivered_at TEXT
    );

    CREATE TABLE IF NOT EXISTS shipment_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
      status      TEXT    NOT NULL,
      location    TEXT    NOT NULL DEFAULT '',
      note        TEXT    NOT NULL DEFAULT '',
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    -- Cross-cutting -----------------------------------------------------
    CREATE TABLE IF NOT EXISTS notifications (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind       TEXT    NOT NULL,
      message    TEXT    NOT NULL,
      read_at    TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_id   INTEGER,
      entity     TEXT    NOT NULL,
      entity_id  INTEGER NOT NULL,
      action     TEXT    NOT NULL,
      meta       TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_addr_user       ON addresses(user_id);
    CREATE INDEX IF NOT EXISTS idx_prod_cat        ON products(category_id, status);
    CREATE INDEX IF NOT EXISTS idx_prod_slug       ON products(slug);
    CREATE INDEX IF NOT EXISTS idx_var_prod        ON variants(product_id);
    CREATE INDEX IF NOT EXISTS idx_stock_avail     ON stock_levels(on_hand, reserved);
    CREATE INDEX IF NOT EXISTS idx_move_variant    ON stock_movements(variant_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_cart_user       ON carts(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_cartitem_cart   ON cart_items(cart_id);
    CREATE INDEX IF NOT EXISTS idx_order_cust      ON orders(customer_id, placed_at);
    CREATE INDEX IF NOT EXISTS idx_order_status    ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_oitem_order     ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_pay_order       ON payments(order_id);
    CREATE INDEX IF NOT EXISTS idx_ret_order       ON returns(order_id, status);
    CREATE INDEX IF NOT EXISTS idx_refund_return   ON refunds(return_id);
    CREATE INDEX IF NOT EXISTS idx_ship_order      ON shipments(order_id);
    CREATE INDEX IF NOT EXISTS idx_shevent_ship    ON shipment_events(shipment_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_notif_user      ON notifications(user_id, read_at);
    CREATE INDEX IF NOT EXISTS idx_audit_entity    ON audit_events(entity, entity_id);
  `);
}

export function audit(actorId, entity, entityId, action, meta = {}) {
  db.prepare(
    'INSERT INTO audit_events (actor_id, entity, entity_id, action, meta) VALUES (?,?,?,?,?)'
  ).run(actorId ?? null, entity, entityId, action, JSON.stringify(meta));
}

export function notify(userId, kind, message) {
  db.prepare('INSERT INTO notifications (user_id, kind, message) VALUES (?,?,?)')
    .run(userId, kind, message);
}
// EPIC E2 - Catalogue: categories, products, SKUs and pricing
import { Router } from 'express';
import { db, audit } from '../db.js';
import { requireAuth, requireRole, actorId } from '../auth.js';
import { formatINR } from '../money.js';

const r = Router();

const MERCH = ['merchandiser', 'admin'];

/** Present a variant with its parent product and its availability, computed not stored. */
const withAvailability = (v) => ({
  id: v.id,
  sku: v.sku,
  name: v.name,
  product_id: v.product_id,
  product_name: v.product_name,
  product_slug: v.product_slug,
  brand: v.brand,
  price_paise: v.price_paise,
  price_display: formatINR(v.price_paise),
  in_stock: v.available > 0,
  available: v.available,
});

const variantSql = `
  SELECT v.*, p.slug AS product_slug, p.name AS product_name, p.brand,
         (s.on_hand - s.reserved) AS available
    FROM variants v
    JOIN products p     ON p.id = v.product_id
    LEFT JOIN stock_levels s ON s.variant_id = v.id
`;

// ------------------------------------------------------------------ public
r.get('/categories', (_req, res) => {
  res.json({ data: db.prepare(`
      SELECT c.*, COUNT(p.id) AS product_count
        FROM categories c
        LEFT JOIN products p ON p.category_id = c.id AND p.status = 'active'
       GROUP BY c.id ORDER BY c.name`).all() });
});

/** US-2.1 Browse and search the catalogue. Pagination is enforced, not hoped for. */
r.get('/catalog', (req, res) => {
  const { q, category, brand, min, max, sort = 'name', page = '1', per = '20' } = req.query;
  const perPage = Math.min(Math.max(Number(per) || 20, 1), 100);
  const pageNo = Math.max(Number(page) || 1, 1);

  const where = ["p.status = 'active'"];
  const params = {};
  if (q) { where.push('(p.name LIKE :q OR p.brand LIKE :q OR v.sku LIKE :q)'); params.q = `%${q}%`; }
  if (category) { where.push('c.slug = :category'); params.category = category; }
  if (brand) { where.push('p.brand = :brand'); params.brand = brand; }
  if (min !== undefined) { where.push('v.price_paise >= :min'); params.min = Number(min); }
  if (max !== undefined) { where.push('v.price_paise <= :max'); params.max = Number(max); }

  const sorts = {
    name: 'p.name ASC',
    'price_asc': 'v.price_paise ASC',
    'price_desc': 'v.price_paise DESC',
    newest: 'p.id DESC',
  };
  const orderBy = sorts[sort] ?? sorts.name;
  const clause = where.join(' AND ');

  const base = `
    FROM variants v
    JOIN products p   ON p.id = v.product_id
    JOIN categories c ON c.id = p.category_id
    LEFT JOIN stock_levels s ON s.variant_id = v.id
    WHERE ${clause} AND v.active = 1
  `;

  const total = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(params).n;
  const data = db.prepare(`${variantSql} WHERE ${clause} AND v.active = 1 ORDER BY ${orderBy} LIMIT :limit OFFSET :offset`)
    .all({ ...params, limit: perPage, offset: (pageNo - 1) * perPage })
    .map(withAvailability);

  res.json({ page: pageNo, per_page: perPage, total, pages: Math.ceil(total / perPage) || 1, data });
});

r.get('/products/:slug', (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE slug = ?').get(req.params.slug);
  if (!p || p.status === 'archived') return res.status(404).json({ error: 'product not found' });
  const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(p.category_id);
  const variants = db.prepare(`${variantSql} WHERE v.product_id = ? AND v.active = 1 ORDER BY v.id`)
    .all(p.id).map(withAvailability);
  res.json({ data: { ...p, category, variants } });
});

// ------------------------------------------------------------------- admin
r.post('/admin/products', requireAuth, requireRole(...MERCH), (req, res) => {
  const { slug, name, category_id, brand = '', description = '', status = 'draft', variants = [] } = req.body || {};
  if (!slug || !name || !category_id) {
    return res.status(400).json({ error: 'slug, name and category_id are required' });
  }
  if (!['draft', 'active', 'archived'].includes(status)) {
    return res.status(400).json({ error: 'status must be draft, active or archived' });
  }
  if (db.prepare('SELECT id FROM products WHERE slug = ?').get(slug)) {
    return res.status(409).json({ error: 'slug already in use' });
  }
  if (!db.prepare('SELECT id FROM categories WHERE id = ?').get(category_id)) {
    return res.status(400).json({ error: 'unknown category' });
  }

  // Product + its SKUs + their opening stock must land together or not at all.
  const tx = db.transaction(() => {
    const pid = db.prepare(
      'INSERT INTO products (slug, name, category_id, brand, description, status) VALUES (?,?,?,?,?,?)'
    ).run(slug, name, category_id, brand, description, status).lastInsertRowid;
    for (const v of variants) {
      const vid = db.prepare('INSERT INTO variants (product_id, sku, name, price_paise) VALUES (?,?,?,?)')
        .run(pid, v.sku, v.name, v.price_paise).lastInsertRowid;
      db.prepare('INSERT INTO stock_levels (variant_id, on_hand, reserved) VALUES (?,?,0)')
        .run(vid, Number(v.opening_stock) || 0);
      if (v.opening_stock) {
        db.prepare(
          'INSERT INTO stock_movements (variant_id, delta, reason, ref_type, ref_id, actor_id) VALUES (?,?,?,?,?,?)'
        ).run(vid, Number(v.opening_stock), 'opening_stock', 'product', pid, actorId(req));
      }
    }
    return pid;
  });

  const id = tx();
  audit(actorId(req), 'product', id, 'product.created', { slug, variants: variants.length });
  res.status(201).json({ data: db.prepare('SELECT * FROM products WHERE id = ?').get(id) });
});

r.patch('/admin/products/:id', requireAuth, requireRole(...MERCH), (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'product not found' });
  const { name, description, brand, status, category_id } = req.body || {};
  if (status !== undefined && !['draft', 'active', 'archived'].includes(status)) {
    return res.status(400).json({ error: 'status must be draft, active or archived' });
  }
  db.prepare(`UPDATE products SET name = ?, description = ?, brand = ?, status = ?, category_id = ? WHERE id = ?`)
    .run(name ?? p.name, description ?? p.description, brand ?? p.brand,
      status ?? p.status, category_id ?? p.category_id, p.id);
  audit(actorId(req), 'product', p.id, 'product.updated', { status });
  res.json({ data: db.prepare('SELECT * FROM products WHERE id = ?').get(p.id) });
});

r.get('/admin/products/:id', requireAuth, requireRole(...MERCH), (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'product not found' });
  const variants = db.prepare(`${variantSql} WHERE v.product_id = ? ORDER BY v.id`).all(p.id).map(withAvailability);
  res.json({ data: { ...p, variants } });
});

/** US-2.4 Add a SKU to an existing product. */
r.post('/admin/products/:id/variants', requireAuth, requireRole(...MERCH), (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'product not found' });
  const { sku, name, price_paise } = req.body || {};
  if (!sku || !name || price_paise === undefined) {
    return res.status(400).json({ error: 'sku, name and price_paise are required' });
  }
  if (!Number.isInteger(Number(price_paise)) || Number(price_paise) < 0) {
    return res.status(400).json({ error: 'price_paise must be a non-negative integer' });
  }
  if (db.prepare('SELECT id FROM variants WHERE sku = ?').get(sku)) {
    return res.status(409).json({ error: 'sku already in use' });
  }
  const tx = db.transaction(() => {
    const vid = db.prepare('INSERT INTO variants (product_id, sku, name, price_paise) VALUES (?,?,?,?)')
      .run(p.id, sku, name, Number(price_paise)).lastInsertRowid;
    db.prepare('INSERT INTO stock_levels (variant_id, on_hand, reserved) VALUES (?,0,0)').run(vid);
    return vid;
  });
  const vid = tx();
  audit(actorId(req), 'variant', vid, 'variant.created', { sku, price_paise: Number(price_paise) });
  res.status(201).json({ data: db.prepare('SELECT * FROM variants WHERE id = ?').get(vid) });
});

/**
 * US-2.5 Reprice a SKU. Historical orders are untouched: order_items snapshotted
 * unit_price_paise at placement, so a price change never rewrites the past.
 */
r.patch('/admin/variants/:id/price', requireAuth, requireRole(...MERCH), (req, res) => {
  const v = db.prepare('SELECT * FROM variants WHERE id = ?').get(req.params.id);
  if (!v) return res.status(404).json({ error: 'variant not found' });
  const { price_paise } = req.body || {};
  if (!Number.isInteger(Number(price_paise)) || Number(price_paise) < 0) {
    return res.status(400).json({ error: 'price_paise must be a non-negative integer' });
  }
  const before = v.price_paise;
  db.prepare('UPDATE variants SET price_paise = ? WHERE id = ?').run(Number(price_paise), v.id);
  audit(actorId(req), 'variant', v.id, 'variant.repriced', { from: before, to: Number(price_paise) });
  res.json({
    data: db.prepare('SELECT * FROM variants WHERE id = ?').get(v.id),
    previous_price_paise: before,
  });
});

export default r;
// EPIC E1 - Identity, access and role management
import { Router } from 'express';
import { db, audit, notify } from '../db.js';
import {
  hashPassword, verifyPassword, signToken, requireAuth, requireRole, actorId,
  ROLES, SELF_REGISTER_ROLES,
} from '../auth.js';

const r = Router();

export const publicUser = (u) => ({
  id: u.id, name: u.name, email: u.email, role: u.role, created_at: u.created_at,
});

r.post('/auth/register', (req, res) => {
  const { name, email, password, role = 'customer' } = req.body || {};
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email and password are required' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }
  if (!SELF_REGISTER_ROLES.includes(role)) {
    // The staff roles are the whole point of the RBAC story; letting anyone
    // claim one at signup would make it decorative.
    return res.status(403).json({ error: 'role cannot be self-assigned', allowed: SELF_REGISTER_ROLES });
  }
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'email already registered' });
  }
  const info = db
    .prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)')
    .run(name, email, hashPassword(password), role);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  audit(user.id, 'user', user.id, 'user.registered', { role });
  notify(user.id, 'welcome', 'Welcome to ShopHub. Your account is active.');
  res.status(201).json({ user: publicUser(user), token: signToken(user) });
});

r.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row || !verifyPassword(password, row.password_hash)) {
    // Audit the attempt even when the email is unknown, so brute force is visible.
    audit(row?.id ?? null, 'user', row?.id ?? 0, 'user.login_failed', { email });
    return res.status(401).json({ error: 'invalid credentials' });
  }
  audit(row.id, 'user', row.id, 'user.logged_in', {});
  res.json({ user: publicUser(row), token: signToken(row) });
});

r.get('/auth/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(actorId(req));
  if (!user) return res.status(404).json({ error: 'user not found' });
  res.json({ user: publicUser(user) });
});

// ---------------------------------------------------------------- addresses
r.get('/me/addresses', requireAuth, (req, res) => {
  res.json({ data: db.prepare('SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id')
    .all(actorId(req)) });
});

r.post('/me/addresses', requireAuth, (req, res) => {
  const { label, line1, city, pincode, is_default = 0 } = req.body || {};
  if (!label || !line1 || !city || !pincode) {
    return res.status(400).json({ error: 'label, line1, city and pincode are required' });
  }
  if (!/^\d{6}$/.test(String(pincode))) {
    return res.status(400).json({ error: 'pincode must be 6 digits' });
  }
  const uid = actorId(req);
  const tx = db.transaction(() => {
    if (is_default) db.prepare('UPDATE addresses SET is_default = 0 WHERE user_id = ?').run(uid);
    return db.prepare(
      'INSERT INTO addresses (user_id, label, line1, city, pincode, is_default) VALUES (?,?,?,?,?,?)'
    ).run(uid, label, line1, city, pincode, is_default ? 1 : 0);
  });
  const info = tx();
  audit(uid, 'address', info.lastInsertRowid, 'address.created', { label });
  res.status(201).json({ data: db.prepare('SELECT * FROM addresses WHERE id = ?').get(info.lastInsertRowid) });
});

// ------------------------------------------------------------ notifications
r.get('/me/notifications', requireAuth, (req, res) => {
  const uid = actorId(req);
  const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(uid).n;
  res.json({
    unread,
    data: db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(uid),
  });
});

r.post('/me/notifications/:id/read', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?')
    .get(req.params.id, actorId(req));
  if (!row) return res.status(404).json({ error: 'notification not found' });
  if (row.read_at) {
    // Reading twice is a client bug, not a state to silently absorb.
    return res.status(409).json({ error: 'notification already read' });
  }
  db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE id = ?").run(row.id);
  res.json({ data: db.prepare('SELECT * FROM notifications WHERE id = ?').get(row.id) });
});

// ------------------------------------------------------------ admin: users
r.get('/admin/users', requireAuth, requireRole('admin'), (req, res) => {
  const { role, search } = req.query;
  const where = [];
  const params = {};
  if (role) { where.push('role = :role'); params.role = role; }
  if (search) { where.push('(name LIKE :q OR email LIKE :q)'); params.q = `%${search}%`; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  res.json({
    data: db.prepare(`SELECT * FROM users ${clause} ORDER BY role, name LIMIT 200`).all(params)
      .map(publicUser),
  });
});

r.post('/admin/users', requireAuth, requireRole('admin'), (req, res) => {
  const { name, email, password, role } = req.body || {};
  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: 'name, email, password and role are required' });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: 'unknown role', valid: ROLES });
  }
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'email already registered' });
  }
  const info = db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?,?,?,?)')
    .run(name, email, hashPassword(password), role);
  audit(actorId(req), 'user', info.lastInsertRowid, 'user.provisioned', { role });
  notify(info.lastInsertRowid, 'account_created', `Your ${role} account has been created.`);
  res.status(201).json({
    data: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)),
  });
});

r.patch('/admin/users/:id/role', requireAuth, requireRole('admin'), (req, res) => {
  const { role } = req.body || {};
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'unknown role', valid: ROLES });
  if (Number(req.params.id) === actorId(req)) {
    // An admin demoting themselves can lock everyone out of user management.
    return res.status(422).json({ error: 'an admin cannot change their own role' });
  }
  const info = db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'user not found' });
  audit(actorId(req), 'user', Number(req.params.id), 'user.role_changed', { role });
  res.json({ data: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id)) });
});

export default r;
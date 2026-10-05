// ShopHub - auth (PBKDF2-SHA512 password hashing, JWT bearer tokens, guards)
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const ITERATIONS = 120_000;   // deliberately slow; 120k is the OWASP floor for PBKDF2-SHA512
const KEYLEN = 64;
const DIGEST = 'sha512';
const ISSUER = 'shop-hub';

export const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
export const JWT_TTL = process.env.JWT_TTL || '2h';

export const ROLES = ['customer', 'agent', 'warehouse', 'merchandiser', 'finance', 'admin'];

/** Only a customer may create their own account; every other role is provisioned. */
export const SELF_REGISTER_ROLES = ['customer'];

export function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.pbkdf2Sync(plain, salt, ITERATIONS, KEYLEN, DIGEST).toString('hex');
  return `pbkdf2$${ITERATIONS}$${salt}$${derived}`;
}

export function verifyPassword(plain, stored) {
  try {
    const [scheme, iter, salt, digest] = String(stored).split('$');
    if (scheme !== 'pbkdf2') return false;
    const derived = crypto.pbkdf2Sync(plain, salt, Number(iter), KEYLEN, DIGEST).toString('hex');
    const a = Buffer.from(derived, 'hex');
    const b = Buffer.from(digest, 'hex');
    // Constant-time compare: a length mismatch must not short-circuit either.
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), role: user.role, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: JWT_TTL, issuer: ISSUER }
  );
}

export function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'unauthenticated' });
  try {
    req.user = jwt.verify(token, JWT_SECRET, { issuer: ISSUER });
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid_token' });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
    if (!roles.includes(req.user.role)) {
      // Tell the caller who would have been allowed, so the refusal is debuggable
      // without granting anything.
      return res.status(403).json({ error: 'forbidden', required_roles: roles, your_role: req.user.role });
    }
    return next();
  };
}

export const actorId = (req) => Number(req.user.sub);
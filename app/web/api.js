// ShopHub - API client for the console.
//
// Deliberately thin. The server decides prices, tax, availability, order state
// and permissions; this file fetches and formats. There is no client-side
// business logic to disagree with the API.
//
// The token is held in a module variable for the session rather than in
// localStorage, so a browser reload signs you out instead of leaving a
// long-lived credential on disk.
const API = '/api/v1';

let token = null;
let user = null;
const listeners = new Set();

export const state = { user: null, meta: null };

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  state.user = user;
  for (const fn of listeners) fn(state);
}

export const isAuthed = () => Boolean(token && user);
export const role = () => user?.role ?? null;
export const isStaff = () => ['agent', 'warehouse', 'merchandiser', 'finance', 'admin'].includes(user?.role);

/** Thrown for any non-2xx, carrying the server's own message so screens can show it. */
export class ApiError extends Error {
  constructor(status, body) {
    super(ApiError.describe(status, body));
    this.status = status;
    this.body = body ?? {};
  }

  /**
   * Turn a response into one sentence a person can act on.
   *
   * Order matters: the server's own error strings are checked before the
   * status-code fallbacks. A 403 with `role cannot be self-assigned` is far
   * more useful when it explains itself than when it reports "Not allowed."
   */
  static describe(status, body) {
    const e = body?.error;
    if (e === 'insufficient_stock') return `Not enough stock for ${body.sku}. ${body.available} available.`;
    if (e === 'unauthenticated') return 'Please sign in again.';
    if (e === 'invalid credentials') return 'Email or password is wrong.';
    if (e === 'email already registered') return 'That email is already registered.';
    if (e === 'role cannot be self-assigned') {
      const allowed = body?.allowed ?? [];
      return allowed.length
        ? `Only ${allowed.join(', ')} accounts can be self-registered.`
        : 'Only customer accounts can be self-registered.';
    }
    if (e === 'password must be at least 8 characters') return 'Password must be at least 8 characters.';
    if (e === 'sku already in use') return 'That SKU is already in use.';
    if (e === 'slug already in use') return 'That product slug is already in use.';
    if (e === 'cart is empty') return 'Your cart is empty.';
    if (e === 'no delivery address on file') return 'Add a delivery address first.';
    if (e === 'order must be delivered before it can be returned') return 'You can only return a delivered order.';
    if (e === 'order already has a shipment') return 'This order has already been dispatched.';
    if (e === 'tracking_no already used') return 'That tracking number is already in use.';
    if (e === 'idempotency_key of at least 8 characters is required') return 'A payment needs an idempotency key.';
    if (e === 'payment_failed') return `Payment declined (${body?.reason ?? 'unknown'}).`;
    if (e === 'unknown endpoint') return 'That endpoint does not exist.';
    if (typeof e === 'string' && e.startsWith('illegal transition')) {
      const allowed = body?.allowed ?? [];
      return allowed.length
        ? `Cannot move there. From here you can go to: ${allowed.join(', ')}.`
        : 'This order is finished and cannot change.';
    }

    // Status-code fallbacks, once the specific strings above have had their turn.
    if (status === 401) return 'Please sign in again.';
    if (status === 403) {
      const roles = body?.required_roles;
      return roles?.length
        ? `Not allowed. Needs: ${roles.join(' or ')}. You are ${body?.your_role ?? 'unknown'}.`
        : 'Not allowed.';
    }
    if (status === 404) return 'Not found.';
    if (typeof e === 'string') return e.replace(/_/g, ' ');
    return `Request failed (${status}).`;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* a 204 or an HTML error page; handled by the status check below */
  }

  if (!res.ok) throw new ApiError(res.status, payload);
  return payload;
}

// --------------------------------------------------------------- formatting
/**
 * Paise to a rupee string. The only place money becomes text, and it is a
 * display concern - nothing computed in the browser feeds back into an amount.
 */
export function inr(paise) {
  const n = Number(paise ?? 0);
  const neg = n < 0;
  const abs = Math.abs(n);
  const rupees = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  const grouped = String(rupees).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}\u20b9${grouped}.${rest}`;
}

export function shortDate(value) {
  if (!value) return '-';
  const d = new Date(String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function relative(value) {
  if (!value) return '-';
  const d = new Date(String(value).replace(' ', 'T') + (String(value).includes('Z') ? '' : 'Z'));
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (Number.isNaN(secs)) return String(value);
  const table = [[60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.35, 'week'], [12, 'month']];
  let value_ = secs;
  let unit = 'second';
  for (const [step, next] of table) {
    if (Math.abs(value_) < step) break;
    value_ = Math.round(value_ / step);
    unit = next;
  }
  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-value_, unit);
}

export const titleCase = (s) => String(s ?? '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// --------------------------------------------------------------------- auth
export async function login(email, password) {
  const res = await api('/auth/login', { method: 'POST', body: { email, password } });
  token = res.token;
  user = res.user;
  emit();
  return user;
}

export async function register(name, email, password) {
  const res = await api('/auth/register', { method: 'POST', body: { name, email, password } });
  token = res.token;
  user = res.user;
  emit();
  return user;
}

export function signOut() {
  token = null;
  user = null;
  emit();
}

/** Re-read the profile from the server, so a stale token fails loudly. */
export async function refresh() {
  if (!token) return null;
  const res = await api('/auth/me');
  user = res.user;
  emit();
  return user;
}

/** A key that is stable per order, so a retried payment cannot double-charge. */
export function idempotencyKey(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
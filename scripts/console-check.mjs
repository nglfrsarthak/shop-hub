// throwaway: exercise the console's API client the way the browser will
import { api, ApiError, inr, shortDate, relative, titleCase, ApiError as E } from '../app/web/api.js';

const BASE = 'http://127.0.0.1:3210';
const fail = [];
const ok = (name, cond, extra = '') => {
  if (cond) console.log('  OK   ' + name);
  else { fail.push(name); console.log('  FAIL ' + name + ' ' + extra); }
};

// --- formatting (no network) ---
console.log('formatting');
// 589764 paise is 5897 rupees and 64 paise - the last two digits are paise.
ok('inr formats paise', inr(589764) === '\u20b95,897.64', inr(589764));
ok('inr groups thousands', inr(123456789) === '\u20b91,234,567.89', inr(123456789));
ok('inr pads a single paise', inr(1) === '\u20b90.01', inr(1));
ok('inr of zero', inr(0) === '\u20b90.00', inr(0));
ok('inr of null', inr(null) === '\u20b90.00', String(inr(null)));
ok('inr of one rupee', inr(100) === '\u20b91.00', inr(100));
ok('inr negative', /^-/.test(inr(-500)), inr(-500));
ok('inr has no float drift', inr(89900) === '\u20b9899.00', inr(89900));
ok('titleCase', titleCase('out_for_delivery') === 'Out For Delivery', titleCase('out_for_delivery'));
ok('shortDate handles junk', shortDate('nonsense') === 'nonsense', shortDate('nonsense'));
ok('shortDate handles null', shortDate(null) === '-', String(shortDate(null)));
ok('relative handles junk', relative('nonsense') === 'nonsense', relative('nonsense'));

console.log('error messages');
const desc = (s, b) => new ApiError(s, b).message;
ok('401 -> sign in again', desc(401, { error: 'unauthenticated' }) === 'Please sign in again.');
ok('403 names the roles needed', /agent or finance/.test(desc(403, { required_roles: ['agent', 'finance'], your_role: 'customer' })), desc(403, { required_roles: ['agent', 'finance'], your_role: 'customer' }));
ok('insufficient_stock names the SKU', /AUR-ANC-02/.test(desc(409, { error: 'insufficient_stock', sku: 'AUR-ANC-02', available: 0 })), desc(409, { error: 'insufficient_stock', sku: 'AUR-ANC-02', available: 0 }));
ok('illegal transition lists legal states', /picking, packed/.test(desc(422, { error: 'illegal transition paid -> shipped', allowed: ['picking', 'packed'] })), desc(422, { error: 'illegal transition paid -> shipped', allowed: ['picking', 'packed'] }));
ok('terminal state says so', desc(422, { error: 'illegal transition delivered -> cancelled', allowed: [] }) === 'This order is finished and cannot change.', desc(422, { error: 'illegal transition delivered -> cancelled', allowed: [] }));
ok('unknown endpoint', desc(404, { error: 'unknown endpoint' }) === 'That endpoint does not exist.');
ok('payment declined', /declined/.test(desc(402, { error: 'payment_failed', reason: 'card_declined' })), desc(402, { error: 'payment_failed', reason: 'card_declined' }));
ok('self-assign role refusal', /self-registered/.test(desc(403, { error: 'role cannot be self-assigned' })), desc(403, { error: 'role cannot be self-assigned' }));
ok('self-assign names what is allowed', /customer/.test(desc(403, { error: 'role cannot be self-assigned', allowed: ['customer'] })), desc(403, { error: 'role cannot be self-assigned', allowed: ['customer'] }));
// A 403 carrying a specific reason must not be flattened to "Not allowed."
ok('a specific 403 beats the generic one',
  desc(403, { error: 'role cannot be self-assigned', allowed: ['customer'] }) !== 'Not allowed.');
ok('underscores become spaces', desc(400, { error: 'name_email_and_password_required' }) === 'name email and password required', desc(400, { error: 'name_email_and_password_required' }));
ok('bare 403 has no roles', desc(403, {}) === 'Not allowed.', desc(403, {}));

console.log('live calls');
const reg = await fetch(BASE + '/api/v1/auth/register', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Console Probe', email: `probe${Date.now()}@shop.test`, password: 'Passw0rd!' }),
}).then((r) => r.json());

// The console calls fetch('/api/v1/...') - a same-origin absolute path. Point it
// at the running server by giving the URL a host. api() has already added the
// /api/v1 prefix, so this must not add one again.
const realFetch = globalThis.fetch;
globalThis.fetch = (u, o) => realFetch(u.startsWith('http') ? u : BASE + u, o);
const { login, register, signOut, isAuthed, role, idempotencyKey } = await import('../app/web/api.js');

ok('starts signed out', !isAuthed());
await login('aarav@shop.test', 'Passw0rd!');
ok('signs in as a customer', isAuthed() && role() === 'customer', String(role()));

const dash = await api('/dashboard');
ok('dashboard returns role cards', Array.isArray(dash.cards) && dash.cards.length > 0);
ok('dashboard reports its role', dash.role === 'customer', dash.role);

const cat = await api('/catalog?per=5');
ok('catalogue page loads', Array.isArray(cat.data) && cat.data.length > 0);
ok('catalogue rows name their product', !!cat.data[0].product_name);
ok('catalogue rows show a display price', /^\u20b9/.test(cat.data[0].price_display), cat.data[0].price_display);

const prod = await api('/products/aurora-headphones');
ok('product page loads', prod.data.variants.length > 0);
ok('variants agree with in_stock', prod.data.variants.every((v) => v.in_stock === (v.available > 0)));

const cart = await api('/cart');
ok('cart is reachable', Array.isArray(cart.data.items));
ok('cart total is internally consistent',
  cart.data.subtotal_paise - cart.data.discount_paise + cart.data.tax_paise + cart.data.shipping_paise === cart.data.total_paise);

const orders = await api('/orders?per=5');
ok('orders list loads', Array.isArray(orders.data));

// a customer hitting a staff route must surface the server's refusal
try {
  await api('/inventory');
  ok('customer is refused the inventory route', false, 'it did not throw');
} catch (e) {
  ok('customer is refused the inventory route', e instanceof ApiError && e.status === 403, `${e.status} ${e.message}`);
  ok('the refusal explains itself', /Needs:/.test(e.message), e.message);
}

// sign in as finance and read the screens the customer could not
await login('anil@shop.test', 'Passw0rd!');
const recon = await api('/finance/reconciliation');
ok('reconciliation identity holds', recon.net_settled_paise === recon.gross_captured_paise - recon.refunded_paise);
ok('reconciliation never goes negative', recon.net_settled_paise >= 0, String(recon.net_settled_paise));
const ledger = await api('/payments');
ok('payment ledger loads', Array.isArray(ledger.data));
const top = await api('/insights/top-products');
ok('best sellers load', Array.isArray(top.data));

await login('admin@shop.test', 'Passw0rd!');
const audit = await api('/audit?limit=5');
ok('audit ledger loads as admin', Array.isArray(audit.data) && audit.data.length > 0);

await login('vikram@shop.test', 'Passw0rd!');
const inv = await api('/inventory');
ok('inventory loads as warehouse', inv.data.length > 0);
ok('inventory summary is present', inv.summary && inv.summary.skus > 0);
const low = await api('/inventory/low-stock');
ok('low-stock report loads', Array.isArray(low.data));

signOut();
ok('signs out', !isAuthed());

const key = idempotencyKey('console-7');
ok('idempotency key is long enough', key.length >= 8, key);
ok('idempotency keys differ per call', idempotencyKey('x') !== idempotencyKey('x'));

console.log('');
console.log(fail.length === 0 ? 'CONSOLE CONTRACT: ALL OK' : `CONSOLE CONTRACT: ${fail.length} FAILED`);
for (const f of fail) console.log('  - ' + f);
process.exit(fail.length ? 1 : 0);
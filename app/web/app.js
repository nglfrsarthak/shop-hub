// ShopHub console - hash router and screens.
//
// A role can navigate to any screen and be refused by the API if the token does
// not permit it. That is deliberate: hiding a link would make the console look
// secure without proving anything, and the 403 is the interesting evidence.
import {
  api, ApiError, state, onChange, isAuthed, role, isStaff,
  inr, shortDate, relative, titleCase,
  login, register, signOut, refresh, idempotencyKey,
} from './api.js';

const app = document.getElementById('app');
let banner = null;
let busy = false;

// -------------------------------------------------------------------- routes
// `roles: null` means anyone. Declaring a role list is documentation, not
// enforcement - the API is the authority and will answer 403 regardless.
const ROUTES = [
  { path: '/',          screen: 'dashboard',  label: 'Dashboard',    roles: null },
  { path: '/catalog',   screen: 'catalog',    label: 'Catalogue',    roles: null },
  { path: '/cart',      screen: 'cart',       label: 'Cart',         roles: ['customer'] },
  { path: '/orders',    screen: 'orders',     label: 'Orders',       roles: null },
  { path: '/returns',   screen: 'returns',    label: 'Returns',      roles: null },
  { path: '/inventory', screen: 'inventory',  label: 'Inventory',    roles: ['warehouse', 'merchandiser', 'admin'] },
  { path: '/products',  screen: 'products',   label: 'Products',     roles: ['merchandiser', 'admin'] },
  { path: '/shipments', screen: 'shipments',  label: 'Shipments',    roles: ['warehouse', 'agent', 'admin'] },
  { path: '/payments',  screen: 'payments',   label: 'Payments',     roles: ['finance', 'admin'] },
  { path: '/users',     screen: 'users',      label: 'Users',        roles: ['admin'] },
];

// Hash routes are written "#/orders/6", so the leading slash has to come off
// before splitting. Left in, "/orders/6".split("/") is ["", "orders", "6"] and
// the first segment - the one that identifies the screen - is empty, which made
// every route resolve to "/" and the dashboard render no matter where you went.
const parseHash = () => {
  const raw = location.hash.replace(/^#/, '').replace(/^\/+/, '');
  if (!raw) return { path: '/', params: [] };
  const [path, ...rest] = raw.split('/');
  return { path: `/${path}`, params: rest.filter(Boolean) };
};

function navigate(path) {
  location.hash = `#${path}`;
}

function visibleRoutes() {
  const r = role();
  if (!r) return [];
  return ROUTES.filter((route) => !route.roles || route.roles.includes(r));
}

// ------------------------------------------------------------------- helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function flash(message, kind = 'error') {
  banner = { message, kind };
  render();
}

function clearBanner() {
  banner = null;
}

const statusChip = (s) => `<span class="chip chip-${esc(s)}">${esc(titleCase(s))}</span>`;

function table(columns, rows, empty = 'Nothing to show.') {
  if (!rows.length) return `<p class="empty">${esc(empty)}</p>`;
  return `
    <div class="table-wrap">
      <table>
        <thead><tr>${columns.map((c) => `<th${c.num ? ' class="num"' : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>
        <tbody>
          ${rows.map((row) => `<tr>${columns.map((c) => {
            const v = c.render ? c.render(row) : row[c.key];
            return `<td${c.num ? ' class="num"' : ''}>${v ?? '-'}</td>`;
          }).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function card(label, value, display) {
  return `<div class="card">
    <div class="card-label">${esc(label)}</div>
    <div class="card-value">${esc(display ?? value ?? '-')}</div>
  </div>`;
}

// -------------------------------------------------------------------- sign in
function renderSignIn() {
  const isRegister = app.dataset.mode === 'register';
  app.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="brand"><span class="brand-mark">S</span> ShopHub</div>
        <p class="muted">Ecommerce operations console</p>

        <div class="tabs">
          <button class="tab${isRegister ? '' : ' active'}" data-mode="login">Sign in</button>
          <button class="tab${isRegister ? ' active' : ''}" data-mode="register">Create customer account</button>
        </div>

        <form id="auth-form" class="stack">
          ${isRegister ? '<label>Full name<input name="name" required autocomplete="name" placeholder="Aarav Sharma"></label>' : ''}
          <label>Email<input name="email" type="email" required autocomplete="username" placeholder="aarav@shop.test"></label>
          <label>Password<input name="password" type="password" required minlength="8" autocomplete="current-password" placeholder="Passw0rd!"></label>
          ${banner ? `<div class="banner banner-${banner.kind}">${esc(banner.message)}</div>` : ''}
          <button class="btn btn-primary" type="submit"${busy ? ' disabled' : ''}>
            ${busy ? 'Working...' : (isRegister ? 'Create account' : 'Sign in')}
          </button>
        </form>

        <div class="demo">
          <div class="demo-title">Demo accounts &mdash; password <code>Passw0rd!</code></div>
          <div class="demo-grid">
            ${[
              ['aarav@shop.test', 'customer'],
              ['neha@shop.test', 'agent'],
              ['vikram@shop.test', 'warehouse'],
              ['priya@shop.test', 'merchandiser'],
              ['anil@shop.test', 'finance'],
              ['admin@shop.test', 'admin'],
            ].map(([email, r]) => `<button class="demo-btn" data-demo="${email}">
              <span>${email}</span><em>${r}</em></button>`).join('')}
          </div>
        </div>
      </div>
    </div>`;

  for (const btn of app.querySelectorAll('[data-mode]')) {
    btn.addEventListener('click', () => { app.dataset.mode = btn.dataset.mode; clearBanner(); render(); });
  }
  for (const btn of app.querySelectorAll('[data-demo]')) {
    btn.addEventListener('click', () => {
      const form = app.querySelector('#auth-form');
      form.email.value = btn.dataset.demo;
      form.password.value = 'Passw0rd!';
      form.requestSubmit();
    });
  }

  app.querySelector('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    busy = true;
    render();
    try {
      if (isRegister) await register(f.name.value, f.email.value, f.password.value);
      else await login(f.email.value, f.password.value);
      clearBanner();
      navigate('/');
    } catch (err) {
      banner = { message: err.message, kind: 'error' };
    } finally {
      busy = false;
      render();
    }
  });
}

// ------------------------------------------------------------------ chrome
function renderChrome(inner) {
  const routes = visibleRoutes();
  const { path } = parseHash();
  return `
    <div class="shell">
      <aside class="side">
        <div class="brand"><span class="brand-mark">S</span> ShopHub</div>
        <nav>
          ${routes.map((r) => `<a href="#${r.path}" class="${r.path === path ? 'active' : ''}">${esc(r.label)}</a>`).join('')}
        </nav>
        <div class="side-foot">
          <div class="who">
            <strong>${esc(state.user?.name ?? '')}</strong>
            <span class="role role-${esc(state.user?.role)}">${esc(state.user?.role)}</span>
          </div>
          <button class="btn btn-ghost btn-sm" id="signout">Sign out</button>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <h1>${esc(routes.find((r) => r.path === path)?.label ?? 'ShopHub')}</h1>
          <div class="topbar-right">
            ${state.user?.role === 'customer'
              ? `<a class="btn btn-ghost btn-sm" href="#/cart">Cart</a>` : ''}
            <span class="muted">v1.0.0</span>
          </div>
        </header>
        <main class="content">${banner ? `<div class="banner banner-${banner.kind}">${esc(banner.message)}</div>` : ''}${inner}</main>
      </div>
    </div>`;
}

// -------------------------------------------------------------------- screens
const screens = {};

screens.dashboard = async () => {
  const d = await api('/dashboard');
  const cards = d.cards.map((c) => card(c.label, c.value, c.display)).join('');
  const orders = d.recent_orders ?? [];
  return `
    <p class="lede">Signed in as <strong>${esc(d.user.name)}</strong>
      <span class="role role-${esc(d.role)}">${esc(d.role)}</span></p>
    <div class="cards">${cards}</div>
    <h2>Recent orders</h2>
    ${table([
      { label: 'Order', render: (o) => `<a href="#/orders/${o.id}">${esc(o.code)}</a>` },
      { label: 'Status', render: (o) => statusChip(o.status) },
      { label: 'Total', num: true, render: (o) => inr(o.total_paise) },
      { label: 'Placed', render: (o) => shortDate(o.placed_at) },
    ], orders, 'No orders yet.')}`;
};

screens.catalog = async (params) => {
  const q = sessionStorage.getItem('cat-q') ?? '';
  const sort = sessionStorage.getItem('cat-sort') ?? 'name';
  const category = sessionStorage.getItem('cat-cat') ?? '';
  const list = await api(`/catalog?per=20&sort=${encodeURIComponent(sort)}`
    + (q ? `&q=${encodeURIComponent(q)}` : '')
    + (category ? `&category=${encodeURIComponent(category)}` : ''));
  const cats = await api('/categories');

  const head = `
    <form class="toolbar" id="cat-form">
      <input name="q" value="${esc(q)}" placeholder="Search products or SKUs">
      <select name="category">
        <option value="">All categories</option>
        ${cats.data.map((c) => `<option value="${esc(c.slug)}"${c.slug === category ? ' selected' : ''}>${esc(c.name)} (${c.product_count})</option>`).join('')}
      </select>
      <select name="sort">
        ${[['name', 'Name A-Z'], ['price_asc', 'Price low-high'], ['price_desc', 'Price high-low'], ['newest', 'Newest']]
          .map(([v, l]) => `<option value="${v}"${v === sort ? ' selected' : ''}>${l}</option>`).join('')}
      </select>
      <button class="btn btn-primary" type="submit">Search</button>
    </form>
    <p class="muted">${list.total} SKU${list.total === 1 ? '' : 's'} &middot; page ${list.page} of ${list.pages}</p>`;

  if (params[0]) return renderProduct(params[0]);

  return head + table([
    { label: 'Product', render: (v) => `<a href="#/catalog/${esc(v.product_slug)}"><strong>${esc(v.product_name)}</strong></a>` },
    { label: 'SKU', render: (v) => `<code>${esc(v.sku)}</code>` },
    { label: 'Variant', render: (v) => esc(v.name) },
    { label: 'Price', num: true, render: (v) => inr(v.price_paise) },
    { label: 'Available', num: true, render: (v) => (v.available > 0 ? `<span class="ok">${v.available}</span>` : '<span class="bad">Out of stock</span>') },
    ...(role() === 'customer' ? [{
      label: '', render: (v) => (v.available > 0
        ? `<button class="btn btn-sm" data-add="${v.id}">Add to cart</button>` : ''),
    }] : []),
  ], list.data);
};

function renderProduct(slug) {
  return `<div id="product-pane" data-slug="${esc(slug)}"><p class="muted">Loading...</p></div>`;
}

async function loadProduct(slug) {
  const pane = document.getElementById('product-pane');
  if (!pane) return;
  const p = await api(`/products/${slug}`);
  pane.innerHTML = `
    <a class="back" href="#/catalog">&larr; All products</a>
    <h2>${esc(p.data.name)}</h2>
    <p class="muted">${esc(p.data.brand)} &middot; ${esc(p.data.category?.name ?? '')}</p>
    <p>${esc(p.data.description)}</p>
    <h3>Variants</h3>
    ${table([
      { label: 'SKU', render: (v) => `<code>${esc(v.sku)}</code>` },
      { label: 'Variant', render: (v) => esc(v.name) },
      { label: 'Price', num: true, render: (v) => inr(v.price_paise) },
      { label: 'Available', num: true, render: (v) => (v.available > 0 ? `<span class="ok">${v.available}</span>` : '<span class="bad">0</span>') },
      ...(role() === 'customer' ? [{
        label: '', render: (v) => (v.available > 0
          ? `<button class="btn btn-sm" data-add="${v.id}">Add to cart</button>` : ''),
      }] : []),
    ], p.data.variants)}
    <p class="muted">${esc(p.data.description)}</p>`;
  wireAddButtons();
}

screens.cart = async () => {
  const { data: c } = await api('/cart');
  const lines = c.items.map((i) => `
    <tr>
      <td><strong>${esc(i.product_name)}</strong><br><code>${esc(i.sku)}</code> &middot; ${esc(i.variant_name)}</td>
      <td class="num">${inr(i.unit_price_paise)}</td>
      <td class="num">
        <div class="stepper">
          <button class="btn btn-sm" data-dec="${i.id}">&minus;</button>
          <span>${i.qty}</span>
          <button class="btn btn-sm" data-inc="${i.id}"${i.qty >= i.available ? ' disabled' : ''}>+</button>
        </div>
      </td>
      <td class="num">${inr(i.line_total_paise)}</td>
      <td class="num"><button class="btn btn-sm btn-danger" data-rm="${i.id}">Remove</button></td>
    </tr>`).join('');

  if (!c.items.length) return '<p class="empty">Your cart is empty. <a href="#/catalog">Browse the catalogue</a>.</p>';

  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Item</th><th class="num">Unit</th><th class="num">Qty</th><th class="num">Line total</th><th></th></tr></thead>
        <tbody>${lines}</tbody>
      </table>
    </div>
    <div class="totals">
      <div><span>Subtotal</span><b>${inr(c.subtotal_paise)}</b></div>
      <div><span>GST (18%)</span><b>${inr(c.tax_paise)}</b></div>
      <div><span>Shipping</span><b>${c.shipping_paise === 0 ? 'Free' : inr(c.shipping_paise)}</b></div>
      <div class="grand"><span>Total</span><b>${inr(c.total_paise)}</b></div>
    </div>
    <div class="row-actions">
      <button class="btn btn-primary" id="checkout">Place order</button>
      <span class="muted">Shipping is free over ${inr(50000)}.</span>
    </div>`;
};

screens.orders = async (params) => {
  if (params[0]) return renderOrder(params[0]);
  const list = await api('/orders?per=25');
  return `<p class="muted">${list.total} order${list.total === 1 ? '' : 's'}</p>` + table([
    { label: 'Order', render: (o) => `<a href="#/orders/${o.id}"><strong>${esc(o.code)}</strong></a>` },
    { label: 'Status', render: (o) => statusChip(o.status) },
    { label: 'Items', num: true, render: (o) => o.item_count },
    { label: 'Total', num: true, render: (o) => inr(o.total_paise) },
    { label: 'Placed', render: (o) => shortDate(o.placed_at) },
  ], list.data, 'No orders yet.');
};

function renderOrder(id) {
  return `<div id="order-pane" data-id="${esc(id)}"><p class="muted">Loading...</p></div>`;
}

async function loadOrder(id) {
  const pane = document.getElementById('order-pane');
  if (!pane) return;
  const { data: o } = await api(`/orders/${id}`);
  const isOwner = o.customer_id === state.user?.id;
  const canCancel = isOwner || ['agent', 'finance', 'admin'].includes(state.user?.role);
  const canAdvance = ['warehouse', 'agent', 'admin'].includes(state.user?.role);

  const totals = `
    <div class="totals">
      <div><span>Subtotal</span><b>${inr(o.subtotal_paise)}</b></div>
      <div><span>GST (18%)</span><b>${inr(o.tax_paise)}</b></div>
      <div><span>Shipping</span><b>${o.shipping_paise === 0 ? 'Free' : inr(o.shipping_paise)}</b></div>
      <div class="grand"><span>Total</span><b>${inr(o.total_paise)}</b></div>
    </div>`;

  const shipTo = o.ship_to;
  pane.innerHTML = `
    <a class="back" href="#/orders">&larr; All orders</a>
    <div class="order-head">
      <h2>${esc(o.code)}</h2>
      ${statusChip(o.status)}
    </div>
    ${o.customer ? `<p class="muted">Customer: <strong>${esc(o.customer.name)}</strong> &lt;${esc(o.customer.email)}&gt;</p>` : ''}
    <p class="muted">Placed ${shortDate(o.placed_at)} &middot; updated ${relative(o.updated_at)}</p>

    <h3>Items</h3>
    ${table([
      { label: 'SKU', render: (i) => `<code>${esc(i.sku)}</code>` },
      { label: 'Item', render: (i) => esc(i.name) },
      { label: 'Qty', num: true, render: (i) => i.qty },
      { label: 'Unit', num: true, render: (i) => inr(i.unit_price_paise) },
      { label: 'Total', num: true, render: (i) => inr(i.line_total_paise) },
      ...(isOwner && o.status === 'delivered'
        ? [{ label: '', render: (i) => `<button class="btn btn-sm" data-return="${i.id}" data-qty="${i.qty}">Return</button>` }] : []),
    ], o.items)}
    ${totals}

    <h3>Ship to</h3>
    <p>${esc(shipTo.label)} &middot; ${esc(shipTo.line1)}, ${esc(shipTo.city)} ${esc(shipTo.pincode)}</p>

    <h3>Payment</h3>
    <p>${o.payment
      ? `${statusChip(o.payment.status)} ${esc(titleCase(o.payment.method))} ${o.payment.receipt_no ? `&middot; receipt <code>${esc(o.payment.receipt_no)}</code>` : ''}`
      : '<span class="muted">Not paid yet.</span>'}</p>

    ${o.shipment ? `<h3>Shipment</h3>
      <p>${statusChip(o.shipment.status)} &middot; ${esc(o.shipment.carrier)} &middot; <code>${esc(o.shipment.tracking_no)}</code></p>` : ''}

    <h3>Actions</h3>
    <div class="row-actions">
      ${o.status === 'placed' && (isOwner || ['agent', 'finance', 'admin'].includes(state.user?.role))
        ? `<button class="btn btn-primary" id="pay">Pay ${inr(o.total_paise)}</button>` : ''}
      ${canCancel && ['paid', 'cancelled'].includes(o.status)
        ? `<button class="btn btn-danger" id="cancel">Cancel order</button>` : ''}
      ${canCancel && o.status === 'placed'
        ? `<button class="btn btn-danger" id="cancel">Cancel order</button>` : ''}
      ${canAdvance && o.allowed_transitions.includes('picking')
        ? `<button class="btn" data-advance="picking">Start picking</button>` : ''}
      ${canAdvance && o.allowed_transitions.includes('packed')
        ? `<button class="btn" data-advance="packed">Mark packed</button>` : ''}
      ${canAdvance && o.status === 'packed'
        ? `<a class="btn btn-primary" href="#/shipments">Dispatch</a>` : ''}
      ${!canCancel && !canAdvance ? '<span class="muted">No actions available to your role.</span>' : ''}
    </div>
    ${o.allowed_transitions.length
      ? `<p class="muted small">Legal next states: ${o.allowed_transitions.map(titleCase).join(', ')}</p>`
      : '<p class="muted small">This order has reached a final state.</p>'}`;

  document.getElementById('pay')?.addEventListener('click', async () => {
    busy = true;
    render();
    try {
      // A stable key per order attempt: a double click replays instead of charging twice.
      await api(`/orders/${id}/pay`, {
        method: 'POST',
        body: { method: 'card', card_number: '4242424242424242', idempotency_key: `console-${id}` },
      });
      flash('Payment captured.', 'ok');
      await loadOrder(id);
    } catch (err) {
      flash(err.message, 'error');
    } finally {
      busy = false;
    }
  });

  document.getElementById('cancel')?.addEventListener('click', async () => {
    try {
      const res = await api(`/orders/${id}/cancel`, { method: 'POST', body: { reason: 'cancelled from console' } });
      flash(res.refunded ? 'Order cancelled and refunded.' : 'Order cancelled.', 'ok');
      await loadOrder(id);
    } catch (err) {
      flash(err.message, 'error');
    }
  });

  for (const btn of pane.querySelectorAll('[data-advance]')) {
    btn.addEventListener('click', async () => {
      try {
        await api(`/orders/${id}/status`, { method: 'POST', body: { status: btn.dataset.advance } });
        flash(`Order is now ${btn.dataset.advance}.`, 'ok');
        await loadOrder(id);
      } catch (err) {
        flash(err.message, 'error');
      }
    });
  }

  for (const btn of pane.querySelectorAll('[data-return]')) {
    btn.addEventListener('click', async () => {
      const reason = prompt('Reason for return?', 'arrived damaged');
      if (reason === null) return;
      try {
        await api('/returns', { method: 'POST', body: { order_item_id: Number(btn.dataset.return), qty: 1, reason } });
        flash('Return requested.', 'ok');
        await loadOrder(id);
      } catch (err) {
        flash(err.message, 'error');
      }
    });
  }
}

screens.returns = async () => {
  const { data } = await api('/returns');
  const staff = ['agent', 'finance', 'admin'].includes(state.user?.role);
  const steps = { requested: ['approved', 'rejected'], approved: ['received'], received: ['refunded'], rejected: [], refunded: [] };

  return `<p class="muted">${data.length} return${data.length === 1 ? '' : 's'}</p>` + table([
    { label: 'Order', render: (x) => `<a href="#/orders/${x.order_id}">${esc(x.order_code ?? x.order_id)}</a>` },
    { label: 'Reason', render: (x) => esc(x.reason) },
    { label: 'Qty', num: true, render: (x) => x.qty },
    { label: 'Status', render: (x) => statusChip(x.status) },
    { label: 'Raised', render: (x) => relative(x.created_at) },
    ...(staff ? [{
      label: 'Move to',
      render: (x) => (steps[x.status] ?? []).map((s) =>
        `<button class="btn btn-sm" data-return-id="${x.id}" data-to="${s}">${esc(titleCase(s))}</button>`).join(' '),
    }] : []),
  ], data, 'No returns.');
};

screens.inventory = async () => {
  const [{ data, summary }, low] = await Promise.all([
    api('/inventory'), api('/inventory/low-stock'),
  ]);
  return `
    <div class="cards">
      ${card('SKUs tracked', summary.skus)}
      ${card('Units on hand', summary.total_on_hand)}
      ${card('Units reserved', summary.total_reserved)}
      ${card('Below reorder point', summary.low_stock, String(summary.low_stock),)}
    </div>
    <h2>Stock levels</h2>
    ${table([
      { label: 'SKU', render: (v) => `<code>${esc(v.sku)}</code>` },
      { label: 'Product', render: (v) => esc(v.product_name) },
      { label: 'On hand', num: true, render: (v) => v.on_hand },
      { label: 'Reserved', num: true, render: (v) => v.reserved },
      { label: 'Available', num: true, render: (v) => (v.available > 0 ? v.available : `<span class="bad">0</span>`) },
      { label: 'Reorder at', num: true, render: (v) => v.reorder_point },
    ], data)}
    <h2>Needs reordering</h2>
    ${table([
      { label: 'SKU', render: (v) => `<code>${esc(v.sku)}</code>` },
      { label: 'Product', render: (v) => esc(v.product_name) },
      { label: 'Available', num: true, render: (v) => v.available },
      { label: 'Reorder at', num: true, render: (v) => v.reorder_point },
    ], low, 'Everything is above its reorder point.')}`;
};

screens.products = async () => {
  const list = await api('/catalog?per=50&sort=newest');
  // The catalogue read is public, so this screen renders for anyone who reaches
  // it by typing the hash. Hiding the nav link is not access control - the
  // Reprice control only appears for the roles allowed to use it. The server
  // rejects the write regardless; this just avoids offering a button that
  // cannot work.
  const canReprice = ['merchandiser', 'admin'].includes(role());
  return `<p class="muted">${list.total} SKU${list.total === 1 ? '' : 's'} live</p>` + table([
    { label: 'Product', render: (v) => `<strong>${esc(v.product_name)}</strong>` },
    { label: 'Brand', render: (v) => esc(v.brand) },
    { label: 'SKU', render: (v) => `<code>${esc(v.sku)}</code>` },
    { label: 'Price', num: true, render: (v) => inr(v.price_paise) },
    { label: 'Available', num: true, render: (v) => v.available },
    ...(canReprice ? [{ render: (v) => `<button class="btn btn-sm" data-reprice="${v.id}" data-price="${v.price_paise}">Reprice</button>` }] : []),
  ], list.data);
};

screens.shipments = async () => {
  const { data } = await api('/shipments');
  const byStatus = ['label_created', 'in_transit', 'out_for_delivery', 'delivered'];
  const next = { label_created: ['in_transit'], in_transit: ['out_for_delivery', 'delivered'], out_for_delivery: ['delivered'], delivered: [] };

  const packed = isStaff() ? await api('/orders?status=packed') : { data: [] };

  return `
    ${packed.data.length ? `<h2>Ready to dispatch</h2>${table([
      { label: 'Order', render: (o) => `<a href="#/orders/${o.id}">${esc(o.code)}</a>` },
      { label: 'Items', num: true, render: (o) => o.item_count },
      { label: 'Total', num: true, render: (o) => inr(o.total_paise) },
      { label: '', render: (o) => `<button class="btn btn-primary btn-sm" data-dispatch="${o.id}">Dispatch</button>` },
    ], packed.data)}` : ''}

    <h2>Shipments</h2>
    ${table([
      { label: 'Order', render: (s) => `<a href="#/orders/${s.order_id}">${esc(s.order_code ?? s.order_id)}</a>` },
      { label: 'Carrier', render: (s) => esc(s.carrier) },
      { label: 'Tracking', render: (s) => `<code>${esc(s.tracking_no)}</code>` },
      { label: 'Status', render: (s) => statusChip(s.status) },
      { label: 'Shipped', render: (s) => (s.shipped_at ? shortDate(s.shipped_at) : '-') },
      { label: 'Next', render: (s) => (next[s.status] ?? []).map((st) =>
        `<button class="btn btn-sm" data-ship="${s.id}" data-to="${st}">${esc(titleCase(st))}</button>`).join(' '),
      },
    ], data, 'No shipments yet.')}`;
};

screens.payments = async () => {
  const [ledger, recon] = await Promise.all([
    api('/payments'), api('/finance/reconciliation'),
  ]);
  return `
    <div class="cards">
      ${card('Gross captured', recon.gross_captured_paise, recon.gross_display)}
      ${card('Refunded', recon.refunded_paise, recon.refunded_display)}
      ${card('Net settled', recon.net_settled_paise, recon.net_display)}
      ${card('Failed attempts', recon.failed_attempts)}
    </div>
    <p class="lede">Identity checked by the API: <code>${esc(recon.identity)}</code></p>

    <h2>Payments</h2>
    ${table([
      { label: 'Order', render: (p) => `<a href="#/orders/${p.order_id}">${esc(p.order_code)}</a>` },
      { label: 'Amount', num: true, render: (p) => inr(p.amount_paise) },
      { label: 'Method', render: (p) => esc(titleCase(p.method)) },
      { label: 'Status', render: (p) => statusChip(p.status) },
      { label: 'Receipt', render: (p) => (p.receipt_no ? `<code>${esc(p.receipt_no)}</code>` : (p.failure_reason ? `<span class="bad">${esc(p.failure_reason)}</span>` : '-')) },
      { label: 'When', render: (p) => relative(p.created_at) },
    ], ledger.data, 'No payments yet.')}`;
};

screens.users = async () => {
  const [users, audit] = await Promise.all([
    api('/admin/users'), api('/audit?limit=25'),
  ]);
  return `
    <h2>People</h2>
    ${table([
      { label: 'Name', render: (u) => `<strong>${esc(u.name)}</strong>` },
      { label: 'Email', render: (u) => esc(u.email) },
      { label: 'Role', render: (u) => `<span class="role role-${esc(u.role)}">${esc(u.role)}</span>` },
      { label: 'Joined', render: (u) => relative(u.created_at) },
    ], users.data)}

    <h2>Audit ledger</h2>
    ${table([
      { label: 'When', render: (e) => shortDate(e.created_at) },
      { label: 'Who', render: (e) => (e.actor_name ? `${esc(e.actor_name)} <span class="muted">${esc(e.actor_role)}</span>` : '<span class="muted">system</span>') },
      { label: 'Action', render: (e) => `<code>${esc(e.action)}</code>` },
      { label: 'Entity', render: (e) => `${esc(e.entity)} #${e.entity_id}` },
    ], audit.data, 'No audit events yet.')}`;
};

// ------------------------------------------------------------------ wiring
function wireAddButtons() {
  for (const btn of document.querySelectorAll('[data-add]')) {
    btn.addEventListener('click', async () => {
      try {
        const res = await api('/cart/items', { method: 'POST', body: { variant_id: Number(btn.dataset.add), qty: 1 } });
        flash(`Added to cart. Cart total ${inr(res.data.total_paise)}.`, 'ok');
      } catch (err) {
        flash(err.message, 'error');
      }
    });
  }
}

function wireGlobal() {
  document.getElementById('signout')?.addEventListener('click', () => {
    signOut();
    navigate('/');
  });

  const catForm = document.getElementById('cat-form');
  catForm?.addEventListener('submit', (e) => {
    e.preventDefault();
    sessionStorage.setItem('cat-q', catForm.q.value.trim());
    sessionStorage.setItem('cat-cat', catForm.category.value);
    sessionStorage.setItem('cat-sort', catForm.sort.value);
    clearBanner();
    render();
  });

  for (const btn of document.querySelectorAll('[data-inc]')) {
    btn.addEventListener('click', async () => {
      try { await api(`/cart/items/${btn.dataset.inc}`, { method: 'PATCH', body: { qty: Number(btn.closest('tr').querySelector('span').textContent) + 1 } }); clearBanner(); await render(true); }
      catch (err) { flash(err.message, 'error'); }
    });
  }
  for (const btn of document.querySelectorAll('[data-dec]')) {
    btn.addEventListener('click', async () => {
      try { await api(`/cart/items/${btn.dataset.dec}`, { method: 'PATCH', body: { qty: Number(btn.closest('tr').querySelector('span').textContent) - 1 } }); clearBanner(); await render(true); }
      catch (err) { flash(err.message, 'error'); }
    });
  }
  for (const btn of document.querySelectorAll('[data-rm]')) {
    btn.addEventListener('click', async () => {
      try { await api(`/cart/items/${btn.dataset.rm}`, { method: 'DELETE' }); await render(true); }
      catch (err) { flash(err.message, 'error'); }
    });
  }

  document.getElementById('checkout')?.addEventListener('click', async () => {
    busy = true;
    render();
    try {
      const { data } = await api('/orders', { method: 'POST', body: {} });
      flash(`Order ${data.code} placed. Total ${inr(data.total_paise)}.`, 'ok');
      navigate(`/orders/${data.id}`);
    } catch (err) {
      flash(err.message, 'error');
      await render(true);
    } finally {
      busy = false;
    }
  });

  for (const btn of document.querySelectorAll('[data-return-id]')) {
    btn.addEventListener('click', async () => {
      try {
        await api(`/returns/${btn.dataset.returnId}/status`, { method: 'PATCH', body: { status: btn.dataset.to } });
        flash(`Return ${btn.dataset.to}.`, 'ok');
        await render(true);
      } catch (err) {
        flash(err.message, 'error');
      }
    });
  }

  for (const btn of document.querySelectorAll('[data-reprice]')) {
    btn.addEventListener('click', async () => {
      const next = prompt('New price in paise (100 paise = Rs 1)', btn.dataset.price);
      if (next === null) return;
      try {
        const res = await api(`/admin/variants/${btn.dataset.reprice}/price`, { method: 'PATCH', body: { price_paise: Number(next) } });
        flash(`Repriced from ${inr(res.previous_price_paise)} to ${inr(res.data.price_paise)}. Existing orders are unchanged.`, 'ok');
        await render(true);
      } catch (err) {
        flash(err.message, 'error');
      }
    });
  }

  for (const btn of document.querySelectorAll('[data-dispatch]')) {
    btn.addEventListener('click', async () => {
      const carrier = prompt('Carrier', 'Delhivery');
      if (carrier === null) return;
      try {
        await api(`/admin/orders/${btn.dataset.dispatch}/ship`, {
          method: 'POST',
          body: { carrier, tracking_no: `TRK${Date.now().toString().slice(-9)}` },
        });
        flash('Dispatched. Stock committed and tracking created.', 'ok');
        await render(true);
      } catch (err) {
        flash(err.message, 'error');
      }
    });
  }

  for (const btn of document.querySelectorAll('[data-ship]')) {
    btn.addEventListener('click', async () => {
      try {
        await api(`/shipments/${btn.dataset.ship}/events`, {
          method: 'POST', body: { status: btn.dataset.to, location: 'Pune' },
        });
        flash(`Shipment ${btn.dataset.to}.`, 'ok');
        await render(true);
      } catch (err) {
        flash(err.message, 'error');
      }
    });
  }

  wireAddButtons();

  const pane = document.getElementById('product-pane');
  if (pane) loadProduct(pane.dataset.slug).catch((err) => flash(err.message, 'error'));
  const orderPane = document.getElementById('order-pane');
  if (orderPane) loadOrder(orderPane.dataset.id).catch((err) => flash(err.message, 'error'));
}

// -------------------------------------------------------------------- render
async function render(quiet = false) {
  if (!isAuthed()) {
    renderSignIn();
    return;
  }

  const { path, params } = parseHash();
  const route = ROUTES.find((r) => r.path === path);
  if (!route) {
    app.innerHTML = renderChrome('<p class="empty">No such screen. <a href="#/">Dashboard</a></p>');
    wireGlobal();
    return;
  }

  // A route's roles gate the nav link, not the route itself. Someone who types
  // the hash, or follows a stale link from another account, must not land on a
  // screen built for a role they do not hold - so it is checked here as well.
  if (route.roles && !route.roles.includes(role())) {
    const allowed = route.roles.join(' or ');
    app.innerHTML = renderChrome(
      `<div class="banner banner-error">This screen is for ${allowed} accounts. You are signed in as ${esc(role())}.</div>`,
    );
    wireGlobal();
    return;
  }

  // Show the frame immediately so navigation feels instant, then fill in data.
  if (!quiet) {
    app.innerHTML = renderChrome('<p class="muted">Loading...</p>');
    wireGlobal();
  }

  try {
    const html = await screens[route.screen](params);
    app.innerHTML = renderChrome(html);
  } catch (err) {
    const message = err instanceof ApiError ? err.message : `Could not load this screen. ${err.message}`;
    app.innerHTML = renderChrome(`<div class="banner banner-error">${esc(message)}</div>`);
    if (err instanceof ApiError && err.status === 401) signOut();
  }
  wireGlobal();
}

onChange(() => render());
window.addEventListener('hashchange', () => render());

(async function boot() {
  // A reload drops the in-memory token, so start from signed-out every time.
  if (!sessionStorage.getItem('seen')) {
    sessionStorage.setItem('seen', '1');
  }
  await render();
})();
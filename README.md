# ShopHub - ecommerce operations platform

An ERP-style backend and web console for a mid-size online retailer: catalogue,
inventory, cart, orders, payments, returns, refunds, fulfilment and reporting,
with role-based access, integer money and closed state machines.

Built as a lab submission. The toolchain is deliberately two tools: **Jira** for
the work, **GitHub** for the code. The `Dockerfile` below is local run
convenience only - it is not part of the pipeline, and CI neither builds nor
publishes an image.

---

## Quick start

```bash
npm install

# terminal 1 - the API and console
cd app
PORT=3000 DB_SEED=true JWT_SECRET=change-me npm start

# terminal 2 - the tests
cd app && npm test
```

Open <http://127.0.0.1:3000>. Use `127.0.0.1`, not `localhost`; on some Windows
setups `localhost` resolves to IPv6 and the listener does not answer.

Seeding is opt-in. `DB_SEED=true` (or `AUTO_SEED=true`) loads demo data on an
empty database; without it you get an empty schema and no demo accounts.

### Demo accounts

Password for all of them: `Passw0rd!`

| Email | Role | What they can do |
| --- | --- | --- |
| `aarav@shop.test` | customer | browse, cart, order, pay, return |
| `diya@shop.test` | customer | as above |
| `neha@shop.test` | agent | support: any order, approve or reject returns |
| `vikram@shop.test` | warehouse | stock in/out, pick, pack, dispatch, receive returns |
| `priya@shop.test` | merchandiser | products, SKUs, pricing |
| `anil@shop.test` | finance | payments, refunds, reconciliation |
| `admin@shop.test` | admin | everything, plus user provisioning and the audit ledger |

Only `customer` can be self-registered. Staff roles exist because an admin
provisions them - which is the point of the access-control stories.

---

## Running in Docker

```bash
docker build -t shophub .

docker run --rm -p 3020:3000 \
  -e JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" \
  -e DB_SEED=true \
  -v shop-data:/data \
  shophub
```

Open <http://127.0.0.1:3020>. `DB_SEED=true` is only needed on the first boot;
leave it off afterwards so restarting does not replay the demo data.

Four things worth knowing about the image:

**It refuses to start without a secret.** `NODE_ENV=production` is set in the
image, so the guard in `auth.js` fires and the container exits rather than
signing tokens with the dev fallback that is committed to this repository. That
is the intended behaviour, but it does mean the `-e JWT_SECRET=...` above is
not optional.

**The database lives in a volume.** `/data/shop.db`, not the container layer,
so removing the container does not remove the data. Drop the volume to start
clean. The bind-mount alternative would put a Linux file inside a Windows
checkout, which is the wrong trade for this app.

**It runs as `node`, uid 1000**, never root.

**Nothing is compiled.** `better-sqlite3` ships a prebuilt `linux-x64` binary,
and `npm ci --ignore-scripts` is what lets it be used as shipped - the package
has a `binding.gyp`, which makes npm run `node-gyp rebuild` even though the
package defines no install script. The build then loads that prebuild in the
build stage, so a binary that would not load fails the build instead of failing
the first database request.

The image is ~376 MB, which is most of it being `node:24-slim`. The application
and its dependencies are a few megabytes.

---

## The rules worth knowing

**Money is an integer number of paise.** Never a float, never a rupee string
inside the database. `src/money.js` is the only place totals are computed, so
the invoice cannot disagree with the arithmetic. Verified to hold over 10 000
synthetic orders.

**Stock cannot be oversold.** Availability is `on_hand - reserved`, and the
check lives *inside* the `UPDATE` that reserves:

```sql
UPDATE stock_levels SET reserved = reserved + ?
 WHERE variant_id = ? AND (on_hand - reserved) >= ?
```

Two orders for the last unit cannot both win: one changes a row, the other
changes nothing and gets a 409 naming the SKU.

**Payments happen once.** The idempotency key is looked up before the gateway is
called. Replaying a request returns the original receipt and writes no second
row. Without a key the endpoint refuses rather than accepting a duplicate-charge
risk.

**Order lines are a snapshot.** `order_items` copies `sku`, `name` and
`unit_price_paise` at checkout. Repricing a product tomorrow does not rewrite
what a customer was charged yesterday.

**Status changes go through a closed machine.** `ORDER_FLOW` has no edges out of
`delivered` or `cancelled`. An illegal move returns 422 with the legal set, so
the caller never has to guess:

```json
{ "error": "illegal transition delivered -> shipped", "allowed": [] }
```

Two edges are deliberately *not* reachable through the plain status endpoint.
`-> shipped` and `-> cancelled` both move stock or money, so they live behind
their own endpoints (`/admin/orders/:id/ship`, `/orders/:id/cancel`) and the
plain endpoint points you there.

---

## Layout

```
app/
  server.js                 entrypoint, logging, health, route mounts
  src/
    db.js                   schema and the only place that names the engine
    auth.js                 PBKDF2-SHA512 hashing, JWT, role guards
    money.js                integer paise arithmetic - the money rule
    gateway.js              stand-in payment gateway, deterministic failures
    seed.js                 demo data
    routes/
      identity.js           E1 accounts, addresses, notifications, user admin
      catalog.js            E2 categories, products, SKUs, pricing
      inventory.js          E3 stock levels, movements, reservation rules
      orders.js             E4 cart, checkout, cancellation, the order machine
      payments.js           E5 payments, returns, refunds, reconciliation
      fulfilment.js         E6 dispatch, tracking events
      insights.js           E7 dashboards, revenue, audit ledger
  tests/api.test.js         74 acceptance tests
  web/                      the console: index.html, app.js, styles.css
scripts/
  smoke-test.mjs            30 checks against a running server
docs/                       the lab submission
Dockerfile                  local run only; CI does not build it
```

18 tables, 50 HTTP endpoints, 6 roles.

### Why the console has no build step

`app/web` is plain HTML, CSS and JavaScript, served as static files. It holds no
business rules - every number it shows comes from the API. Two reasons: a
screenshot of the console is then evidence about the API rather than about a
bundler, and a student can read the whole front end in one sitting.

Hash routing (`#/orders`) means a role can navigate anywhere, and the API
answers 403 rather than the console hiding a link. That is the honest way to
show access control working.

---

## Running the checks

```bash
cd app && npm test                    # 74 acceptance tests, no server needed
node scripts/smoke-test.mjs            # 30 checks against a running server
```

`node --test` and `supertest`, no test framework and no runner config.

---

## Swapping the database

`app/src/db.js` is the only file that knows it is SQLite. Moving to PostgreSQL
means changing that file: `better-sqlite3` becomes `pg`, the `?` placeholders
become `$1`, and `db.transaction(fn)` becomes an explicit `BEGIN`/`COMMIT`. The
routes need no changes, because they only use `prepare().get()/all()/run()` and
the three stock helpers.

The reservation rule needs a real database to preserve its guarantee. Under
SQLite's single writer it holds trivially; under PostgreSQL the same conditional
`UPDATE` is still correct, and `SELECT ... FOR UPDATE` is the belt-and-braces
option.

---

## Known gaps

- No pagination on the console's longer lists, though the API has it everywhere.
- No rate limiting on the login endpoint.
- SQLite is single-writer, which is fine for a demo and wrong for production.
- Cart totals are recomputed on every read; at catalogue scale you would cache
  them and revalidate at checkout.
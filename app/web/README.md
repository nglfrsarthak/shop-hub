# ShopHub

A small back-office web console for an online retailer. Vanilla HTML, CSS and
JavaScript - no build step, no framework, no bundler. Open `index.html` through
the API server and it works.

**The console holds no business rules.** Every number it renders comes from the
API. Prices, tax, availability, order state and permissions are all decided on
the server, and this front end only asks and shows.

```
app/web/
  index.html    the shell: sidebar, header, one <main> the router fills
  app.js        hash router, API client, screens
  styles.css    one stylesheet
```

## Why hash routing

Links look like `http://127.0.0.1:3000/#/orders`. Every role can navigate to
every screen, and the server answers 403 if the token does not permit it.

The obvious alternative - hiding a link the role cannot use - would make the
console *look* more secure while proving nothing. Here the customer can type the
warehouse URL and see the refusal for real. That screenshot is worth more than
one where the link was never there.

## Screens

| Route | Screen | Roles |
| --- | --- | --- |
| `#/` | dashboard, widgets chosen for the signed-in role | all |
| `#/catalog` | browse, search, filter by price | all |
| `#/product/:slug` | product detail, variants, availability | all |
| `#/cart` | cart, quantities, totals, checkout | customer |
| `#/orders` | order list and detail, cancel, pay | all (scoped) |
| `#/returns` | request a return, track its state | customer, agent, finance |
| `#/inventory` | stock levels, low-stock report, movements | warehouse, merchandiser |
| `#/products` | catalogue admin, SKUs, pricing | merchandiser |
| `#/shipments` | dispatch, tracking events | warehouse, agent |
| `#/payments` | ledger and reconciliation | finance |
| `#/users` | staff provisioning, role changes, audit | admin |

## Behaviour worth noting

**No token in localStorage.** The JWT is held in a JavaScript variable for the
session only, so a reload signs you out rather than leaving a long-lived
credential on disk. For a lab this is the more defensible default; for production
you would use an `HttpOnly` cookie with CSRF protection and accept the
complexity that comes with it.

**Errors are shown, not swallowed.** A 409 arrives as
`insufficient stock (AUR-ANC-02)` and appears in the banner. A 422 arrives with
its legal-transition list, so the screen can tell you what *is* possible rather
than just what is not.

**Money arrives as paise and is formatted once.** `formatINR` is the only
renderer. The browser never does arithmetic on an amount.

**Keyboard and screen size.** Every control is a real button, link or input, so
tab order works. The layout is usable down to about 380px wide.

## Deliberate omissions

- No client-side routing library; the hash table is 20 lines.
- No state library; a single `state` object and a `render()` per screen.
- No optimistic updates. On a 409 the UI would be wrong anyway, so it waits for
  the server and shows the reason.
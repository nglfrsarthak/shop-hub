// ShopHub - money. Every amount in this system is an integer number of paise.
//
// This is the single most load-bearing decision in the codebase. Floats lose
// 1 paise somewhere around the tenth order, and a ledger that does not sum is
// not a ledger. Nothing here ever touches a float.
export const PAISE_PER_RUPEE = 100;
export const GST_BASIS_POINTS = 1800;          // 18% GST
export const FLAT_SHIPPING_PAISE = 9900;       // Rs 99
export const FREE_SHIPPING_FROM_PAISE = 50000; // Rs 500

/** GST on an integer amount, rounded half-up in integer space. */
export function taxOn(subtotalPaise) {
  return Math.round((subtotalPaise * GST_BASIS_POINTS) / 10000);
}

/** Flat shipping, waived above the threshold. */
export function shippingFor(subtotalPaise) {
  return subtotalPaise >= FREE_SHIPPING_FROM_PAISE ? 0 : FLAT_SHIPPING_PAISE;
}

/**
 * The one place an order's money is computed. Every figure the customer sees
 * comes from this function, so the invoice cannot disagree with the maths.
 */
export function totalsFor(lines, discountPaise = 0) {
  const subtotal = lines.reduce((sum, l) => sum + l.qty * l.unit_price_paise, 0);
  const discount = Math.max(0, Math.min(discountPaise, subtotal));
  const taxable = subtotal - discount;
  const tax = taxOn(taxable);
  const shipping = shippingFor(subtotal);
  return {
    subtotal_paise: subtotal,
    discount_paise: discount,
    tax_paise: tax,
    shipping_paise: shipping,
    total_paise: taxable + tax + shipping,
  };
}

/** Render paise as a rupee string. Display only - never feed this back in. */
export function formatINR(paise) {
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / PAISE_PER_RUPEE);
  const rest = String(abs % PAISE_PER_RUPEE).padStart(2, '0');
  const grouped = String(rupees).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}\u20b9${grouped}.${rest}`;
}
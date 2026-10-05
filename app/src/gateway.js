// ShopHub - a deliberately small stand-in for a payment gateway.
//
// Real integrations differ only in the signature of this function and in the
// errors they can return, so keeping the rules in one place means swapping in a
// real PSP touches nothing else.
//
// Deterministic test rules (mirroring how sandboxes actually work):
//   - a card ending 0002 is declined, so the failure path is reachable
//   - anything above the single-transaction ceiling is refused
export const MAX_CHARGE_PAISE = 10_000_000; // Rs 1,00,000

export const DECLINE_CARD_SUFFIX = '0002';

export function charge({ amount_paise, method, card_number = '', idempotency_key }) {
  if (!Number.isInteger(amount_paise) || amount_paise <= 0) {
    return { status: 'failed', failure_reason: 'invalid_amount' };
  }
  if (amount_paise > MAX_CHARGE_PAISE) {
    return { status: 'failed', failure_reason: 'limit_exceeded' };
  }
  if (method === 'card' && String(card_number).replace(/\s/g, '').endsWith(DECLINE_CARD_SUFFIX)) {
    return { status: 'failed', failure_reason: 'card_declined' };
  }
  // The receipt is derived from the idempotency key, so the same key always
  // produces the same receipt - which is what makes a replay safe to return.
  const seed = [...String(idempotency_key)].reduce((s, ch) => (s * 31 + ch.charCodeAt(0)) >>> 0, 7);
  return { status: 'captured', receipt_no: `RCPT-${String(seed % 100000).padStart(5, '0')}`, failure_reason: null };
}
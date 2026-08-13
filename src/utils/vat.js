// =========================================================================
// UAE VAT (5%) - single source of truth
// =========================================================================
// Two different, both-correct UAE conventions, used in two different
// places in this codebase - conflating them would be a real compliance
// bug, not just a style choice:
//
// 1. CUSTOMER-FACING prices (menu items, orders, bills) are legally
//    required to be displayed VAT-INCLUSIVE in the UAE - the price on
//    the menu already has VAT baked in. So for these, VAT is derived
//    BACKWARD out of the total, never added on top.
//
// 2. B2B SERVICE CONTRACTS (Tavzio's own contracts/receipts to a
//    business) follow the standard UAE B2B invoicing convention: the
//    agreed fee is the net/subtotal amount, and 5% VAT is added ON TOP
//    as its own line, same as how a UAE law firm or agency invoices a
//    client. This is the conventional assumption for a stated contract
//    value - if Tavzio's contract amounts were actually meant to
//    already include VAT, this would need to change to the inclusive
//    formula instead.
// =========================================================================

const UAE_VAT_RATE = 0.05;

// For customer-facing totals: `amount` already includes VAT (as UAE menu
// pricing law requires) - this splits it into subtotal + VAT rather than
// adding VAT on top of an already-inclusive number.
function calculateVatInclusive(amount) {
  const total = Number(amount) || 0;
  const vatAmount = Math.round((total - total / (1 + UAE_VAT_RATE)) * 100) / 100;
  const subtotalExVat = Math.round((total - vatAmount) * 100) / 100;
  return { subtotalExVat, vatAmount, vatRate: UAE_VAT_RATE, totalIncVat: total };
}

// For B2B contract/receipt amounts: `amount` is the net/subtotal fee -
// this adds 5% VAT on top to get the real amount due.
function calculateVatExclusive(amount) {
  const subtotalExVat = Number(amount) || 0;
  const vatAmount = Math.round(subtotalExVat * UAE_VAT_RATE * 100) / 100;
  const totalIncVat = Math.round((subtotalExVat + vatAmount) * 100) / 100;
  return { subtotalExVat, vatAmount, vatRate: UAE_VAT_RATE, totalIncVat };
}

module.exports = { UAE_VAT_RATE, calculateVatInclusive, calculateVatExclusive };

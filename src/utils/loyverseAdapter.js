// =========================================================================
// Loyverse connector
// =========================================================================
// Confirmed, openly-documented API - developer.loyverse.com, real
// `POST /receipts` endpoint. IMPORTANT HONEST LIMITATION, not a bug to
// fix later: Loyverse's public API creates a "receipt" - a record of an
// ALREADY-COMPLETED, PAID sale, for reporting/accounting. It does NOT
// have a live "pending order that shows up on a kitchen screen" concept
// the way Foodics/Square do - their own developer community has publicly
// asked for exactly that and been told it doesn't exist. So this
// connector is genuinely useful for retail-style businesses (record the
// sale, keep inventory/reports accurate), but NOT a substitute for a real
// kitchen order flow at a restaurant. Surface this distinction to
// whoever configures it - don't oversell it as equivalent to Foodics/Square.
//
// `config` expected shape: { accessToken: string, storeId: string }
// =========================================================================

async function pushOrder(config, order, items) {
  if (!config?.accessToken || !config?.storeId) {
    return { success: false, error: 'Loyverse integration is not fully configured (missing access token or store id)' };
  }

  // TODO: Loyverse's line items reference a `variant_id` from THEIR
  // catalog, not an arbitrary name/price like Foodics or Square accept.
  // Each Tavzio menu item would need its matching Loyverse variant_id
  // mapped somewhere (e.g. a `loyverse_variant_id` column on menu_items)
  // before this can actually run - this is a real setup step, not
  // optional. Left unmapped items will fail below rather than silently
  // sending wrong data.
  const missingMapping = items.some((i) => !i.loyverseVariantId);
  if (missingMapping) {
    return { success: false, error: 'One or more items are not yet mapped to a Loyverse product variant' };
  }

  try {
    const response = await fetch('https://api.loyverse.com/v1.0/receipts', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        store_id: config.storeId,
        order: order.id,
        source: 'Tavzio',
        line_items: items.map((i) => ({
          variant_id: i.loyverseVariantId,
          quantity: i.quantity,
          price: i.unit_price,
        })),
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return { success: false, error: data.message || 'Loyverse rejected the receipt' };
    }
    return { success: true, externalOrderId: data.receipt_number };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { pushOrder };

// =========================================================================
// Square connector
// =========================================================================
// Unlike Foodics, this one is built on CONFIRMED, openly-documented API
// behavior - Square's developer docs are public with no plan-gating found.
// `POST /v2/orders` creates an order that appears directly in Square's own
// Dashboard Order Manager and POS - this is real, not a placeholder.
//
// `config` expected shape: { accessToken: string, locationId: string }
// (obtained via Square's OAuth flow when the business connects their
// account - the access token is scoped to their Square seller account).
// =========================================================================

async function pushOrder(config, order, items) {
  if (!config?.accessToken || !config?.locationId) {
    return { success: false, error: 'Square integration is not fully configured (missing access token or location id)' };
  }

  try {
    const response = await fetch('https://connect.squareup.com/v2/orders', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
        'Square-Version': '2026-05-20',
      },
      body: JSON.stringify({
        idempotency_key: `tavzio-${order.id}`, // Square requires this to prevent duplicate orders on retry
        order: {
          location_id: config.locationId,
          reference_id: order.id,
          line_items: items.map((i) => ({
            name: i.item_name,
            quantity: String(i.quantity),
            base_price_money: {
              amount: Math.round(i.unit_price * 100), // Square uses the smallest currency unit (fils, not AED)
              currency: config.currency || 'AED',
            },
            note: i.note || undefined,
          })),
        },
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      return { success: false, error: data.errors?.[0]?.detail || 'Square rejected the order' };
    }
    return { success: true, externalOrderId: data.order?.id };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { pushOrder };

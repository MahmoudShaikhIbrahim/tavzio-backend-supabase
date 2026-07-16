// =========================================================================
// Foodics connector
// =========================================================================
// WHAT'S REAL: the calling convention below (pushOrder's signature, return
// shape, error handling, and how orderController uses it) is complete and
// correct - this is genuinely how the integration plugs into the rest of
// the system.
//
// WHAT'S NOT YET FILLED IN: the actual HTTP request to Foodics' API inside
// pushOrder(). Foodics gates their full API reference behind a developer
// account that requires the business to be on an "Advanced" plan or have
// purchased an API license (per their own help docs) - it's not something
// I can fabricate without that access. Based on Foodics' publicly
// documented integration pattern (OAuth2 authorization - "Foodics will ask
// for your permission... Authorize App to Access My Account" - then order
// creation via their REST API), the shape below is the right structure to
// fill in once real credentials and endpoint docs are in hand. Everything
// UP TO that HTTP call is real and doesn't need to change.
// =========================================================================

// `config` is whatever was saved in pos_integrations.config for this
// business - expected shape once real credentials exist:
//   { accessToken: string, branchId: string, refreshToken?: string }
async function pushOrder(config, order, items) {
  if (!config?.accessToken || !config?.branchId) {
    return { success: false, error: 'Foodics integration is not fully configured (missing access token or branch id)' };
  }

  try {
    // TODO: replace with the real Foodics order-creation endpoint once
    // developer API access is granted. Expected to be something like:
    //
    // const response = await fetch('https://api.foodics.com/v5/orders', {
    //   method: 'POST',
    //   headers: {
    //     Authorization: `Bearer ${config.accessToken}`,
    //     'Content-Type': 'application/json',
    //   },
    //   body: JSON.stringify({
    //     branch_id: config.branchId,
    //     source: 'tavzio',
    //     table_number: order.table_label,
    //     notes: order.note,
    //     products: items.map((i) => ({
    //       name: i.item_name,
    //       price: i.unit_price,
    //       quantity: i.quantity,
    //       notes: i.note,
    //     })),
    //   }),
    // });
    // const data = await response.json();
    // if (!response.ok) return { success: false, error: data.message || 'Foodics rejected the order' };
    // return { success: true, externalOrderId: data.id };

    throw new Error('Foodics API credentials not yet configured - see TODO above once developer access is granted');
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { pushOrder };

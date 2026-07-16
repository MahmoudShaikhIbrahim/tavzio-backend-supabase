// =========================================================================
// Tap Payments connector (Pay Bill)
// =========================================================================
// Built on Tap's real, documented Charge API. Option A architecture,
// confirmed deliberately: each business connects THEIR OWN Tap secret key
// (obtained by signing up with Tap directly, using their own trade
// license) - Tavzio only ever calls the API using credentials the
// business gave us. Tavzio is never a party to any Tap contract, never
// holds funds, never appears on Tap's side as anything but "a developer
// tool the merchant happens to use."
//
// The actual charge is created from a token already generated client-side
// by Apple Pay / Google Pay's own SDK (via the customer's browser) -
// `tapToken` here is that token, never raw card data.
//
// `config` expected shape: { secretKey: string }
// =========================================================================

// amountAed is a plain decimal (e.g. 45.50) - Tap's Charge API takes
// decimal amounts directly (unlike Square, which wants the smallest unit).
async function createCharge(config, tapToken, amountAed, description) {
  if (!config?.secretKey) {
    return { success: false, error: 'Tap Payments is not configured for this business' };
  }

  try {
    const response = await fetch('https://api.tap.company/v2/charges', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: amountAed,
        currency: 'AED',
        threeDSecure: true,
        save_card: false,
        description: description || 'Tavzio bill payment',
        source: { id: tapToken },
        redirect: { url: '' }, // no redirect needed - Apple/Google Pay resolve in-page
      }),
    });

    const data = await response.json();
    if (!response.ok || data.status === 'DECLINED' || data.status === 'FAILED') {
      return { success: false, error: data.response?.message || data.message || 'Payment was declined' };
    }
    return { success: true, chargeId: data.id, status: data.status };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Refunds all or part of a previous charge. Tap's Refund API takes the
// original charge id and an amount - a partial refund is just a smaller
// amount than the original charge.
async function createRefund(config, chargeId, amountAed, reason) {
  if (!config?.secretKey) {
    return { success: false, error: 'Tap Payments is not configured for this business' };
  }

  try {
    const response = await fetch('https://api.tap.company/v2/refunds', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        charge_id: chargeId,
        amount: amountAed,
        currency: 'AED',
        reason: reason || 'requested_by_customer',
      }),
    });

    const data = await response.json();
    if (!response.ok || data.status === 'FAILED') {
      return { success: false, error: data.response?.message || data.message || 'Refund could not be processed' };
    }
    return { success: true, refundId: data.id, status: data.status };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { createCharge, createRefund };

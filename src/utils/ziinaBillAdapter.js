// =========================================================================
// Ziina connector (Pay Bill) - hosted payment page flow
// =========================================================================
// Deliberately a SEPARATE file from ziinaAdapter.js, which is Tavzio's own
// platform-wide account (env-based ZIINA_API_KEY) used to bill Tavzio's
// own clients via receipts. This file is the opposite ownership model:
// each RESTAURANT connects THEIR OWN Ziina account, exactly like Tap,
// Telr, and N-Genius already work for Pay Bill - `config.apiKey` comes
// from that business's own settings, never from an env var. Tavzio never
// holds the customer's payment or appears in that contract.
//
// Same redirect shape as Telr/N-Genius, so it slots into the existing
// createPaySession/confirmPaySession flow with no new architecture:
// 1. createPaymentSession -> Ziina returns a payment intent id + hosted
//    page URL
// 2. Customer is redirected there, pays on Ziina's own page
// 3. Ziina sends them back to our return URL
// 4. checkPaymentStatus verifies server-side whether it actually
//    succeeded (never trust the redirect alone - same rule as Telr/NGenius)
//
// `config` expected shape: { apiKey: string, testMode?: boolean }
// =========================================================================

// Confirmed against Ziina's own API docs - one fixed production base for
// every merchant account (unlike Telr/N-Genius, there's no per-business
// endpoint to configure - only the API key differs per business).
const ZIINA_API_BASE = 'https://api-v2.ziina.com/api';

function toFils(amountAed) {
  return Math.round(Number(amountAed) * 100);
}

// amountAed is a plain decimal (e.g. 45.50), like every other adapter here.
async function createPaymentSession(config, amountAed, description, cartId, returnUrl) {
  if (!config?.apiKey) {
    return { success: false, error: 'A payment gateway is not configured for this business' };
  }

  try {
    const response = await fetch(`${ZIINA_API_BASE}/payment_intent`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: toFils(amountAed),
        currency_code: 'AED',
        message: description || 'Tavzio bill payment',
        // {PAYMENT_INTENT_ID} is replaced by Ziina itself - carries the
        // intent id back on return the same way Telr/N-Genius carry
        // their own reference, so confirmPaySession always knows exactly
        // which payment to verify regardless of provider.
        success_url: returnUrl,
        cancel_url: returnUrl,
        allow_tips: false,
        test: !!config.testMode,
      }),
    });

    const data = await response.json();
    if (!response.ok || !data.id || !data.redirect_url) {
      return { success: false, error: data.message || 'Ziina did not return a payment link' };
    }
    return { success: true, providerRef: data.id, redirectUrl: data.redirect_url };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Server-side truth check - exactly the same principle as Telr/N-Genius:
// the return URL proves nothing, only this does.
async function checkPaymentStatus(config, providerRef) {
  if (!config?.apiKey) {
    return { success: false, error: 'A payment gateway is not configured for this business' };
  }
  if (!providerRef) {
    return { success: false, error: 'Missing Ziina payment intent id' };
  }

  try {
    const response = await fetch(`${ZIINA_API_BASE}/payment_intent/${providerRef}`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
    });
    const data = await response.json();
    if (!response.ok) {
      return { success: false, error: data.message || 'Could not verify the Ziina payment' };
    }

    // Confirmed against Ziina's own docs - these are the only 5 possible
    // status values. Only 'completed' means paid; everything else
    // (including 'failed') is not paid, and anything mid-flight
    // ('pending', 'requires_payment_instrument', 'requires_user_action')
    // should be treated as not-yet-resolved rather than a hard failure.
    return { success: true, paid: data.status === 'completed', statusText: data.status };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Confirmed against Ziina's own API reference: POST /refund takes
// { payment_intent_id, amount, currency_code }. Same synchronous-enough
// pattern as Tap/N-Genius here - the create call succeeding (an id comes
// back, no error) is treated as the refund being accepted, matching how
// refundController.js uses every adapter's createRefund today. Ziina's
// own GET /refund/{id} exists for later status tracking if ever needed,
// but isn't polled here, consistent with the other two adapters.
async function createRefund(config, providerRef, amountAed) {
  if (!config?.apiKey) {
    return { success: false, error: 'A payment gateway is not configured for this business' };
  }
  if (!providerRef) {
    return { success: false, error: 'Missing Ziina payment intent id to refund' };
  }

  try {
    const response = await fetch(`${ZIINA_API_BASE}/refund`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payment_intent_id: providerRef,
        amount: toFils(amountAed),
        currency_code: 'AED',
        test: !!config.testMode,
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.id) {
      return { success: false, error: data.error?.message || data.message || 'Ziina refund could not be created' };
    }
    return { success: true, refundId: data.id };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { createPaymentSession, checkPaymentStatus, createRefund };

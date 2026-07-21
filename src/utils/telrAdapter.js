// =========================================================================
// Telr connector (Pay Bill) - hosted payment page flow
// =========================================================================
// Unlike Tap (in-page Apple/Google Pay token), Telr is redirect-based:
// 1. createPaymentSession -> Telr returns an order ref + a hosted page URL
// 2. Customer is redirected there, pays on Telr's own page
// 3. Telr sends them back to our return URL
// 4. checkPaymentStatus verifies server-side whether it actually succeeded
//    (never trust the redirect alone - the status check is the truth)
//
// Same ownership model as Tap: each business connects THEIR OWN Telr
// store credentials. Tavzio never holds funds or appears in the contract.
//
// `config` expected shape: { storeId: string, authKey: string, testMode?: boolean }
//
// Operational note (from Telr's own docs): live-mode API calls are only
// accepted from IP addresses pre-approved by Telr - the business must
// give Telr the server's IPs during onboarding. Test mode has no such
// restriction.
// =========================================================================

const TELR_ENDPOINT = 'https://secure.telr.com/gateway/order.json';

// Creates a hosted payment page session. amountAed is a plain decimal
// (e.g. 45.50) - Telr takes decimal amounts directly, like Tap.
async function createPaymentSession(config, amountAed, description, cartId, returnUrl) {
  if (!config?.storeId || !config?.authKey) {
    return { success: false, error: 'Telr is not configured for this business' };
  }

  try {
    const params = new URLSearchParams({
      ivp_method: 'create',
      ivp_store: config.storeId,
      ivp_authkey: config.authKey,
      ivp_amount: String(amountAed),
      ivp_currency: 'AED',
      ivp_test: config.testMode ? '1' : '0',
      ivp_cart: cartId,
      ivp_desc: description || 'Tavzio bill payment',
      // All three outcomes land on the same return handler - it always
      // verifies the real status server-side rather than trusting which
      // URL the customer came back on.
      return_auth: returnUrl,
      return_decl: returnUrl,
      return_can: returnUrl,
    });

    const response = await fetch(TELR_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const data = await response.json();
    if (data.error) {
      return { success: false, error: data.error.message || data.error.note || 'Telr rejected the payment request' };
    }
    if (!data.order?.ref || !data.order?.url) {
      return { success: false, error: 'Telr did not return a payment page' };
    }
    return { success: true, providerRef: data.order.ref, redirectUrl: data.order.url };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Verifies the real outcome of a payment after the customer returns.
// Telr's check response includes order.status.code - per their integration
// guide, code 3 means authorised/paid. 2 is authorised-pending-capture,
// 1 is pending, negative/other codes are declined/cancelled/expired.
async function checkPaymentStatus(config, providerRef) {
  if (!config?.storeId || !config?.authKey) {
    return { success: false, error: 'Telr is not configured for this business' };
  }

  try {
    const params = new URLSearchParams({
      ivp_method: 'check',
      ivp_store: config.storeId,
      ivp_authkey: config.authKey,
      order_ref: providerRef,
    });

    const response = await fetch(TELR_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const data = await response.json();
    if (data.error) {
      return { success: false, paid: false, error: data.error.message || 'Could not verify payment with Telr' };
    }

    const statusCode = Number(data.order?.status?.code);
    const paid = statusCode === 3 || statusCode === 2;
    return { success: true, paid, statusCode, statusText: data.order?.status?.text || '' };
  } catch (err) {
    return { success: false, paid: false, error: err.message };
  }
}

module.exports = { createPaymentSession, checkPaymentStatus };

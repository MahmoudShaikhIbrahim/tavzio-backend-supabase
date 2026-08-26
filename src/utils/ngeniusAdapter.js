// =========================================================================
// N-Genius Online connector (Pay Bill) - Network International's gateway
// =========================================================================
// Redirect-based, same shape as Telr: create order -> redirect the
// customer to N-Genius's hosted page -> they return -> verify the real
// status server-side.
//
// Why this provider matters: Network International (merged with Magnati,
// Oct 2025) is the largest card-machine acquirer in the UAE - this is
// the adapter for the restaurant that says "I'm already with the company
// that gave me my card machine."
//
// Auth model (from NI's official docs): a Service Account API key is
// exchanged for a short-lived access token (5 minutes) before every
// operation. Tokens are cheap to mint, so this adapter just gets a fresh
// one per call rather than caching across the expiry boundary.
//
// `config` expected shape:
//   { apiKey: string, outletRef: string, testMode?: boolean }
// Both values come from the business's own N-Genius Online portal:
// Settings > Integrations > Service Accounts (API key) and
// Settings > Organization Hierarchy (outlet reference UUID).
// =========================================================================

function baseUrl(config) {
  return config?.testMode
    ? 'https://api-gateway.sandbox.ngenius-payments.com'
    : 'https://api-gateway.ngenius-payments.com';
}

async function getAccessToken(config) {
  const response = await fetch(`${baseUrl(config)}/identity/auth/access-token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${config.apiKey}`,
      'Content-Type': 'application/vnd.ni-identity.v1+json',
      Accept: 'application/vnd.ni-identity.v1+json',
    },
    body: JSON.stringify({ realmName: 'ni' }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(data.message || 'Could not authenticate with N-Genius');
  }
  return data.access_token;
}

// Creates an order and returns the hosted payment page URL.
// NOTE (flagged for live testing): per N-Genius convention the amount
// value is in MINOR units (fils) - AED 45.50 is sent as 4550. The
// customer sees the amount on N-Genius's own page before paying, so if
// this convention ever differed for a specific account setup it would be
// caught immediately and visibly in the first test payment, not silently.
async function createPaymentSession(config, amountAed, description, cartId, returnUrl) {
  if (!config?.apiKey || !config?.outletRef) {
    return { success: false, error: 'A payment gateway is not configured for this business' };
  }

  try {
    const token = await getAccessToken(config);
    const response = await fetch(`${baseUrl(config)}/transactions/outlets/${config.outletRef}/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/vnd.ni-payment.v2+json',
        Accept: 'application/vnd.ni-payment.v2+json',
      },
      body: JSON.stringify({
        action: 'SALE',
        amount: { currencyCode: 'AED', value: Math.round(amountAed * 100) },
        merchantOrderReference: cartId,
        emailAddress: 'customer@tavzio.com', // N-Genius requires one; anonymous NFC customers have none
        merchantAttributes: {
          redirectUrl: returnUrl,
          skipConfirmationPage: true,
        },
      }),
    });

    const data = await response.json();
    const paypageUrl = data?._links?.payment?.href;
    if (!response.ok || !data.reference || !paypageUrl) {
      return { success: false, error: data.message || 'N-Genius did not return a payment page' };
    }
    return { success: true, providerRef: data.reference, redirectUrl: paypageUrl };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Verifies the real outcome after the customer returns. Order state
// reaches PURCHASED (sale captured) or CAPTURED when genuinely paid;
// AUTHORISED means approved but not yet captured - counted as paid here
// since SALE-action orders auto-capture.
async function checkPaymentStatus(config, providerRef) {
  if (!config?.apiKey || !config?.outletRef) {
    return { success: false, paid: false, error: 'A payment gateway is not configured for this business' };
  }

  try {
    const token = await getAccessToken(config);
    const response = await fetch(`${baseUrl(config)}/transactions/outlets/${config.outletRef}/orders/${providerRef}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.ni-payment.v2+json',
      },
    });

    const data = await response.json();
    if (!response.ok) {
      return { success: false, paid: false, error: data.message || 'Could not verify payment with N-Genius' };
    }

    const state = (data?._embedded?.payment?.[0]?.state || data?.state || '').toUpperCase();
    const paid = ['PURCHASED', 'CAPTURED', 'AUTHORISED'].includes(state);
    return { success: true, paid, statusCode: state, statusText: state };
  } catch (err) {
    return { success: false, paid: false, error: err.message };
  }
}

// Refunds all or part of a captured payment. Built on NI's documented
// approach: retrieve the order, take the capture's own self link, append
// /refund - avoids hand-assembling the four-reference URL and stays
// correct even if their URL structure shifts. Amount in minor units
// (fils), same convention as order creation.
async function createRefund(config, providerRef, amountAed) {
  if (!config?.apiKey || !config?.outletRef) {
    return { success: false, error: 'A payment gateway is not configured for this business' };
  }

  try {
    const token = await getAccessToken(config);
    const orderRes = await fetch(`${baseUrl(config)}/transactions/outlets/${config.outletRef}/orders/${providerRef}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.ni-payment.v2+json' },
    });
    const order = await orderRes.json();
    const captureHref = order?._embedded?.payment?.[0]?._embedded?.['cnp:capture']?.[0]?._links?.self?.href;
    if (!captureHref) {
      return { success: false, error: 'No captured payment found to refund on this N-Genius order' };
    }

    const refundRes = await fetch(`${captureHref}/refund`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/vnd.ni-payment.v2+json',
        Accept: 'application/vnd.ni-payment.v2+json',
      },
      body: JSON.stringify({ amount: { currencyCode: 'AED', value: Math.round(amountAed * 100) } }),
    });
    const data = await refundRes.json();
    if (!refundRes.ok) {
      return { success: false, error: data.message || 'N-Genius refund was rejected' };
    }
    return { success: true, refundId: data._id || '', status: 'refunded' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { createPaymentSession, checkPaymentStatus, createRefund };

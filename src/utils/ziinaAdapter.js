const crypto = require('crypto');

// Ziina amounts are in the currency's minor unit (fils for AED) - AED
// 300.00 is sent as 30000. Confirmed against Ziina's own OpenAPI schema
// and matches exactly how Scripzio's working integration does it.
function toFils(aedAmount) {
  return Math.round(Number(aedAmount) * 100);
}

// Creates a payment intent and returns the hosted page URL to send the
// payer to. `message` shows on Ziina's own payment page - used here to
// show the receipt number so the payer recognizes what they're paying
// for.
async function createPaymentIntent({ amountAed, message, successUrl, cancelUrl, failureUrl, test }) {
  const baseUrl = process.env.ZIINA_BASE_URL;
  const apiKey = process.env.ZIINA_API_KEY;
  if (!baseUrl || !apiKey) {
    return { success: false, error: 'Ziina is not configured (ZIINA_BASE_URL / ZIINA_API_KEY missing)' };
  }

  try {
    const response = await fetch(`${baseUrl}/payment_intent`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount: toFils(amountAed),
        currency_code: 'AED',
        message,
        success_url: successUrl,
        cancel_url: cancelUrl,
        failure_url: failureUrl,
        allow_tips: false,
        test: !!test,
      }),
    });

    const data = await response.json();
    if (!response.ok || !data.id || !data.redirect_url) {
      return { success: false, error: data.message || 'Ziina did not return a payment link' };
    }
    return { success: true, paymentIntentId: data.id, redirectUrl: data.redirect_url };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Registers Tavzio's webhook endpoint as the account-wide Ziina webhook.
// Deliberately NOT called automatically anywhere - this OVERWRITES
// whatever webhook URL is currently registered for the account (Ziina's
// own docs: "any subsequent call overwrites the webhook URL"). This is a
// one-time, deliberate action a super_admin triggers explicitly, never
// something that runs silently on deploy.
async function registerWebhook(webhookUrl, secret) {
  const baseUrl = process.env.ZIINA_BASE_URL;
  const apiKey = process.env.ZIINA_API_KEY;
  if (!baseUrl || !apiKey) {
    return { success: false, error: 'Ziina is not configured' };
  }

  try {
    const response = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, secret }),
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
      return { success: false, error: data.error || 'Ziina rejected the webhook registration' };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Verifies both the HMAC signature AND the source IP, per Ziina's own
// documented security recommendations - fails CLOSED (rejects) if the
// secret isn't configured, unlike Scripzio's version which fails open in
// that case. Real money moving through this endpoint deserves the
// stricter default.
const ZIINA_WEBHOOK_IPS = ['3.29.184.186', '3.29.190.95', '20.233.47.127', '13.202.161.181'];

function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.ZIINA_WEBHOOK_SECRET;
  if (!secret) return false;
  if (typeof signatureHeader !== 'string' || !rawBody) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch {
    // Buffers of different lengths throw rather than return false -
    // treat that the same as "not a match".
    return false;
  }
}

function isFromZiinaIp(remoteAddress) {
  // Strip an IPv4-mapped-IPv6 prefix (::ffff:1.2.3.4) if present, since
  // Express can report addresses in either form depending on proxy setup.
  const cleaned = (remoteAddress || '').replace('::ffff:', '');
  return ZIINA_WEBHOOK_IPS.includes(cleaned);
}

module.exports = { createPaymentIntent, registerWebhook, verifyWebhookSignature, isFromZiinaIp, toFils };

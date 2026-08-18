// Sends via the Gmail API (HTTPS, OAuth2) rather than SMTP. Railway
// blocks outbound SMTP ports (465/587) on every plan below Pro - a real
// SMTP connection just hangs until the request times out. The Gmail API
// is plain HTTPS, so it's unaffected by that block, costs nothing, and
// - unlike routing through a third-party sender - the email is genuinely
// sent BY founder@tavzio.ae's own Google account, not on its behalf.
//
// Auth is a one-time setup (see README): a Google Cloud OAuth client +
// a refresh token obtained once by signing in as founder@tavzio.ae with
// the gmail.send scope. From then on, this code exchanges that refresh
// token for a short-lived access token on demand - never needs a human
// to sign in again unless the refresh token itself is revoked.
const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

// Access tokens last ~1hr - cached in memory and only refreshed once
// expired, so a burst of sends (e.g. issuing several receipts back to
// back) doesn't re-authenticate on every single one.
let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt) return cachedAccessToken;

  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = process.env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) return null;

  const res = await fetch(GMAIL_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) {
    console.error('Gmail token refresh failed:', await res.text().catch(() => ''));
    return null;
  }
  const data = await res.json();
  cachedAccessToken = data.access_token;
  // Refresh a minute early rather than cutting it exactly at expiry.
  cachedAccessTokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
  return cachedAccessToken;
}

// Base64url, no padding - what the Gmail API's raw message field requires
// (plain base64 with +/ characters or trailing = would be rejected).
function base64url(str) {
  return Buffer.from(str, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Fire-and-forget by design — a notification failing to send should never
// block or slow down the actual login. Errors are logged, not thrown.
async function sendMail({ to, subject, text }) {
  const from = process.env.ALERT_FROM_EMAIL;
  const accessToken = await getAccessToken();
  if (!accessToken || !from) {
    console.warn(`Gmail API not configured — skipped email to ${to}: ${subject}`);
    return;
  }
  try {
    // A real RFC 2822 message, hand-built - the Gmail API takes a raw
    // MIME message rather than separate from/to/subject/body fields.
    const replyTo = process.env.REPLY_TO_EMAIL || from;
    const rawMessage = [
      `From: ${from}`,
      `To: ${to}`,
      `Reply-To: ${replyTo}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      '',
      text,
    ].join('\r\n');

    const res = await fetch(GMAIL_SEND_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: base64url(rawMessage) }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`Gmail send failed (${res.status}):`, body);
    }
  } catch (err) {
    console.error('Email send failed:', err.message);
  }
}

function notifyCardUsed({ email, deviceLabel, businessName }) {
  return sendMail({
    to: email,
    subject: `Your Tavzio admin card was just used`,
    text: `Your admin card for ${businessName} was just tapped and used to log in (${deviceLabel || 'unknown device'}). If this wasn't you, disable the card immediately from your dashboard and change your account password.`,
  });
}

function sendDeviceConfirmation({ email, confirmUrl, businessName }) {
  return sendMail({
    to: email,
    subject: `Confirm this device for your Tavzio dashboard`,
    text: `Someone tapped your admin card on a device we haven't seen before for ${businessName}. If this was you, open this link on that SAME device to finish logging in: ${confirmUrl}\n\nThis link expires in 10 minutes. If this wasn't you, ignore this email and consider disabling the card.`,
  });
}

function sendContractSignLink({ email, businessName, signUrl }) {
  return sendMail({
    to: email,
    subject: `Your Tavzio service agreement is ready to sign`,
    text: `Hi,\n\nYour Tavzio service agreement for ${businessName} is ready. Review and sign it here - takes under a minute, no account needed:\n\n${signUrl}\n\nOnce signed, you'll be asked to add a payment method to activate your subscription.\n\n- Tavzio`,
  });
}

function sendContractSignedReceipt({ email, businessName, receiptNumber, amountAed, pdfUrl }) {
  return sendMail({
    to: email,
    subject: `Receipt ${receiptNumber} - AED ${amountAed.toFixed(2)}`,
    text: `Hi,\n\nYour payment of AED ${amountAed.toFixed(2)} for ${businessName} was received automatically. Receipt ${receiptNumber} is attached to your account - view it here:\n\n${pdfUrl}\n\n- Tavzio`,
  });
}

function sendPaymentFailedWarning({ email, businessName, attempt }) {
  return sendMail({
    to: email,
    subject: `Payment issue with your Tavzio subscription`,
    text: `Hi,\n\nA scheduled payment for ${businessName}'s Tavzio subscription didn't go through (attempt ${attempt}). Please check your card details are current. If this isn't resolved, your account may be suspended.\n\n- Tavzio`,
  });
}

function sendAccountSuspended({ email, businessName }) {
  return sendMail({
    to: email,
    subject: `Your Tavzio account has been suspended`,
    text: `Hi,\n\n${businessName}'s Tavzio account has been suspended due to repeated failed payments. Please contact us to update your payment details and reactivate your account.\n\n- Tavzio`,
  });
}

module.exports = {
  notifyCardUsed, sendDeviceConfirmation, sendMail,
  sendContractSignLink, sendContractSignedReceipt, sendPaymentFailedWarning, sendAccountSuspended,
};

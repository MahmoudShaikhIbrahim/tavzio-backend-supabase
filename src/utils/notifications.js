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
const { supabaseAdmin } = require('../config/supabaseClient');
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
async function sendMail({ to, subject, text, replyTo }) {
  const from = process.env.ALERT_FROM_EMAIL;
  const accessToken = await getAccessToken();
  if (!accessToken || !from) {
    console.warn(`Gmail API not configured — skipped email to ${to}: ${subject}`);
    return;
  }
  try {
    // A real RFC 2822 message, hand-built - the Gmail API takes a raw
    // MIME message rather than separate from/to/subject/body fields.
    const resolvedReplyTo = replyTo || process.env.REPLY_TO_EMAIL || from;
    const rawMessage = [
      `From: ${from}`,
      `To: ${to}`,
      `Reply-To: ${resolvedReplyTo}`,
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
  return sendViaResend({
    to: email,
    from: RESEND_SECURITY_FROM,
    subject: `Your Tavzio admin card was just used`,
    text: `Your admin card for ${businessName} was just tapped and used to log in (${deviceLabel || 'unknown device'}). If this wasn't you, disable the card immediately from your dashboard and change your account password.`,
  });
}

function sendDeviceConfirmation({ email, confirmUrl, businessName }) {
  return sendViaResend({
    to: email,
    from: RESEND_SECURITY_FROM,
    subject: `Confirm this device for your Tavzio dashboard`,
    text: `Someone tapped your admin card on a device we haven't seen before for ${businessName}. If this was you, open this link on that SAME device to finish logging in: ${confirmUrl}\n\nThis link expires in 10 minutes. If this wasn't you, ignore this email and consider disabling the card.`,
  });
}

// Real fix for a confirmed gap: placing a purchase order used to only
// ever write a database row - no actual communication to the supplier
// ever happened, leaving "place an order" a purely internal record with
// no real-world effect. replyTo is the business's own account email
// (the only real contact email on file for a business - there's no
// separate business contact-email field), so the supplier's reply goes
// straight to the business, not to Tavzio's generic inbox.
function sendSupplierOrderEmail({ supplierEmail, supplierName, businessName, businessEmail, poNumber, items, totalAed, notes }) {
  const lines = items.map((i) => `  - ${i.quantity} ${i.unit} × ${i.name}${i.unitCostAed ? ` @ AED ${i.unitCostAed.toFixed(2)} each` : ''}`);
  const text = [
    `Hi${supplierName ? ` ${supplierName}` : ''},`,
    '',
    `${businessName} would like to place the following order${poNumber ? ` (PO ${poNumber})` : ''}:`,
    '',
    ...lines,
    '',
    totalAed ? `Estimated total: AED ${totalAed.toFixed(2)}` : '',
    notes ? `Note from ${businessName}: ${notes}` : '',
    '',
    `Please reply to this email to confirm availability and delivery timing.`,
    '',
    `- ${businessName} (sent via Tavzio)`,
  ].filter(Boolean).join('\n');

  return sendViaResend({
    to: supplierEmail,
    subject: `New order from ${businessName}${poNumber ? ` - PO ${poNumber}` : ''}`,
    text,
    from: supplyFromAddress(businessName),
    replyTo: businessEmail || undefined,
    // A real copy in the business's own inbox - the one thing no From
    // address, however well it's framed, could ever provide on its
    // own. Nothing else about the flow needs businessEmail to be set
    // for this to work at all - if it's missing, this and replyTo both
    // simply don't apply, the order still sends.
    bcc: businessEmail || undefined,
  });
}

function sendContractSignLink({ email, businessName, signUrl }) {
  return sendMail({
    to: email,
    subject: `Your Tavzio service agreement is ready to sign`,
    text: `Hi,\n\nYour Tavzio service agreement for ${businessName} is ready. Review and sign it here - takes under a minute, no account needed:\n\n${signUrl}\n\nOnce signed, you'll be asked to add a payment method to activate your subscription.\n\n- Tavzio`,
  });
}

// The real close of the sign-then-pay flow: sent once, right when
// payment is actually confirmed (Stripe's checkout.session.completed,
// not at the signing step itself - signing alone doesn't guarantee the
// payment step that follows it succeeds). Links to the same PDF
// download endpoint the client already used to review the contract
// before signing - now showing the real signature/stamp images, since
// the contract's status is genuinely 'signed'/'paid'/'active' by the
// time this fires.
function sendSignedContractCopy({ email, businessName, contractNumber, pdfUrl }) {
  return sendMail({
    to: email,
    subject: `Your signed Tavzio agreement - ${contractNumber}`,
    text: `Hi,\n\nThank you - your payment for ${businessName} was received and your Tavzio service agreement is now fully signed and active. Your countersigned copy is ready here:\n\n${pdfUrl}\n\n- Tavzio`,
  });
}

function sendContractSignedReceipt({ email, businessName, receiptNumber, amountAed, pdfUrl }) {
  return sendViaResend({
    to: email,
    from: RESEND_BILLING_FROM,
    subject: `Receipt ${receiptNumber} - AED ${amountAed.toFixed(2)}`,
    text: `Hi,\n\nYour payment of AED ${amountAed.toFixed(2)} for ${businessName} was received automatically. Receipt ${receiptNumber} is attached to your account - view it here:\n\n${pdfUrl}\n\n- Tavzio`,
  });
}

function sendPaymentFailedWarning({ email, businessName, attempt }) {
  return sendViaResend({
    to: email,
    from: RESEND_BILLING_FROM,
    subject: `Payment issue with your Tavzio subscription`,
    text: `Hi,\n\nA scheduled payment for ${businessName}'s Tavzio subscription didn't go through (attempt ${attempt}). Please check your card details are current. If this isn't resolved, your account may be suspended.\n\n- Tavzio`,
  });
}

function sendAccountSuspended({ email, businessName }) {
  return sendViaResend({
    to: email,
    from: RESEND_BILLING_FROM,
    subject: `Your Tavzio account has been suspended`,
    text: `Hi,\n\n${businessName}'s Tavzio account has been suspended due to repeated failed payments. Please contact us to update your payment details and reactivate your account.\n\n- Tavzio`,
  });
}

// Distinct from sendAccountSuspended above - that one is specifically
// about repeated payment failures. A contract termination can happen
// for several different contractual reasons (Section 9: material
// breach, 90-day convenience notice, mutual agreement; Section 3:
// non-payment past 30 days) and the notice sent to the client should
// say which one actually applies, not a generic "suspended" message
// that doesn't match what's actually happening to their account.
const TERMINATION_BASIS_LABEL = {
  non_payment: 'non-payment of fees due under the Agreement',
  material_breach: 'an uncured material breach of the Agreement',
  client_convenience: 'termination for convenience under Section 9 of the Agreement',
  mutual_agreement: 'mutual agreement between the parties',
};
function sendContractTerminated({ email, businessName, reason, basis }) {
  const basisLabel = TERMINATION_BASIS_LABEL[basis] || basis;
  return sendViaResend({
    to: email,
    from: RESEND_BILLING_FROM,
    subject: `Your Tavzio service agreement has been terminated`,
    text: `Hi,\n\nYour Tavzio service agreement for ${businessName} has been terminated, effective immediately, on the basis of ${basisLabel}.${reason ? `\n\nReason provided: ${reason}` : ''}\n\nPer Section 4 of your Agreement, any NFC stands supplied under this Agreement must be returned to Tavzio within fourteen (14) days in good working condition. Please contact us to arrange collection.\n\nYour account access has been suspended as of this notice. If you believe this is in error, please contact us directly.\n\n- Tavzio`,
  });
}

// Real fix, built specifically to avoid repeating the last confirmed
// bug: Supabase's own inviteUserByEmail() (a) can't be called again for
// an email that's already registered - it just errors - and (b) always
// sends via Supabase's own built-in mailer, which both has a strict
// rate limit entirely separate from anything this app controls AND
// shows up to the recipient as coming from Supabase, not Tavzio.
// generateLink() (type: 'invite' for a brand-new user, 'recovery' for
// an existing one) sidesteps both problems at once: it produces a real
// action_link WITHOUT Supabase ever sending anything itself - sending
// is entirely this app's job from here, via Resend below, so the
// email is genuinely Tavzio-branded and never touches Supabase's
// mailer or its rate limit at all.
const RESEND_API_URL = 'https://api.resend.com/emails';
// Two distinct sender identities, both on the same Resend account/
// domain - confirmed: invites read as "Tavzio invited you," billing
// correspondence (receipts, payment failures, suspension, termination)
// reads as "the billing system," a real, deliberate separation, not
// two names for the same thing.
const RESEND_INVITE_FROM = process.env.RESEND_FROM_ADDRESS || 'Tavzio <invites@tavzio.ae>';
const RESEND_BILLING_FROM = process.env.RESEND_BILLING_FROM_ADDRESS || 'Tavzio Billing <billing@tavzio.ae>';
// Card-tap and new-device notices are both account-security events, not
// billing or invites - one identity covers both, distinct from the
// other two for the same reason billing and invites are distinct from
// each other: a person reading "security@" instantly knows the
// category before opening it.
const RESEND_SECURITY_FROM = process.env.RESEND_SECURITY_FROM_ADDRESS || 'Tavzio Security <security@tavzio.ae>';
// Named for the FEATURE (a business sending a campaign to its own
// customers through Tavzio), not "marketing@" - that name would read
// as Tavzio's own marketing to prospects, which this isn't.
const RESEND_CAMPAIGNS_FROM = process.env.RESEND_CAMPAIGNS_FROM_ADDRESS || 'Tavzio Campaigns <campaigns@tavzio.ae>';
// Supplier orders get their own real identity too, same reasoning as
// the other three - but unlike those, the display name here is built
// per-business, not fixed, since the supplier needs to see WHICH
// business is actually ordering, not just that it came via Tavzio.
// Domain verification on Resend covers the whole domain, not
// individual mailboxes - this address needed zero new setup, since
// tavzio.ae is already verified (proven by invites@ already working).
const RESEND_SUPPLY_ADDRESS = process.env.RESEND_SUPPLY_FROM_ADDRESS || 'supply@tavzio.ae';
function supplyFromAddress(businessName) {
  return `${businessName} (via Tavzio Supply) <${RESEND_SUPPLY_ADDRESS}>`;
}

async function sendViaResend({ to, subject, text, from = RESEND_INVITE_FROM, replyTo, bcc }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('RESEND_API_KEY is not set - email was not sent.');
    return;
  }
  const body = { from, to, subject, text };
  if (replyTo) body.reply_to = replyTo;
  if (bcc) body.bcc = bcc;
  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const resBody = await res.text().catch(() => '');
    throw new Error(`Resend send failed (${res.status}): ${resBody}`);
  }
}

function inviteEmailCopy({ name, businessLabel, actionLink }) {
  return {
    subject: `Your Tavzio invite - ${businessLabel}`,
    text: `Hi ${name},\n\nHere's your invite link to activate your Tavzio account for ${businessLabel}. Click below to set your password:\n\n${actionLink}\n\nThis link is single-use and expires after a while - if it's stopped working by the time you click it, just ask whoever invited you to resend it.\n\n- Tavzio`,
  };
}

// The FIRST invite for a brand-new account - generateLink(type:
// 'invite') both creates the unconfirmed user AND returns the link,
// with no email sent by Supabase in the process. Throws with the same
// "already been registered"-shaped error Supabase's own
// inviteUserByEmail used to throw, so the existing fallback-to-resend
// logic in staffController.js/organizationController.js needed no
// change in shape, only in what each branch actually calls.
async function sendNewInviteEmail({ email, name, businessLabel, redirectTo, userMetadata }) {
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: 'invite',
    email,
    options: { redirectTo, data: userMetadata },
  });
  if (error) throw error;

  await sendViaResend({ to: email, ...inviteEmailCopy({ name, businessLabel, actionLink: data.properties.action_link }) });
  return data.user;
}

// The RESEND path, for an email that already has an account (never
// finished onboarding, or is being re-invited after already having
// one) - generateLink(type: 'recovery') works for an existing user
// regardless of whether they ever set a password, unlike 'invite'
// which only works for brand-new emails.
async function resendInviteEmail({ email, name, businessLabel, redirectTo }) {
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: 'recovery',
    email,
    options: { redirectTo },
  });
  if (error) throw error;

  return sendViaResend({ to: email, ...inviteEmailCopy({ name, businessLabel, actionLink: data.properties.action_link }) });
}

// Real fix, found in the same audit as the two above: campaign sends
// used to go through sendMail (Gmail), which is fire-and-forget by
// design and never throws - so marketingController.js's send loop had
// no real way to tell a genuine delivery failure from a success, and
// its own failedCount variable was declared but never actually
// incremented anywhere. sendViaResend DOES throw on a real failure -
// this wraps that so a business's own campaign to its customers goes
// out under campaigns@tavzio.ae (not Tavzio's own founder@ inbox),
// while still returning a clean boolean the caller's loop can check
// per-recipient, rather than letting one bad address throw and abort
// the rest of the campaign.
async function sendCampaignEmail({ to, subject, text }) {
  try {
    await sendViaResend({ to, subject, text, from: RESEND_CAMPAIGNS_FROM });
    return true;
  } catch (err) {
    console.error(`Campaign send to ${to} failed:`, err.message);
    return false;
  }
}

module.exports = {
  notifyCardUsed, sendDeviceConfirmation, sendMail, sendSupplierOrderEmail,
  sendContractSignLink, sendSignedContractCopy, sendContractSignedReceipt, sendPaymentFailedWarning, sendAccountSuspended, sendContractTerminated,
  sendNewInviteEmail, resendInviteEmail, sendCampaignEmail,
};

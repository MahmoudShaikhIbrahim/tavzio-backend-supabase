const nodemailer = require('nodemailer');

let transporter = null;
function getTransporter() {
  if (!process.env.SMTP_HOST) return null; // not configured yet — calls become no-ops
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: Number(process.env.SMTP_PORT) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

// Fire-and-forget by design — a notification failing to send should never
// block or slow down the actual login. Errors are logged, not thrown.
async function sendMail({ to, subject, text }) {
  const t = getTransporter();
  if (!t) {
    console.warn(`SMTP not configured — skipped email to ${to}: ${subject}`);
    return;
  }
  try {
    await t.sendMail({ from: process.env.ALERT_FROM_EMAIL, to, subject, text });
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

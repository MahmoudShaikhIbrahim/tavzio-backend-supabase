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

module.exports = { notifyCardUsed, sendDeviceConfirmation };

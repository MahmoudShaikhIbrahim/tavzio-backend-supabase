// CLIENT_URL holds a comma-separated CORS allowlist (e.g. the real
// domain plus a Vercel fallback URL) - anywhere that needs to build an
// actual link or redirect (sign links, Stripe success URLs, payment
// return URLs) should use only the first, primary origin, never the
// raw env var directly.
function primaryClientUrl() {
  return (process.env.CLIENT_URL || '').split(',')[0].trim();
}

module.exports = { primaryClientUrl };

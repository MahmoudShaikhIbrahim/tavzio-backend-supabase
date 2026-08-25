// CLIENT_URL holds a comma-separated CORS allowlist (e.g. the real
// domain plus a Vercel fallback URL) - anywhere that needs to build an
// actual link or redirect (sign links, Stripe success URLs, payment
// return URLs) should use only the first, primary origin, never the
// raw env var directly.
function primaryClientUrl() {
  return (process.env.CLIENT_URL || '').split(',')[0].trim();
}

// Same pattern, for the backend's own public origin - needed for links
// that must work with no Tavzio account and no logged-in session (a
// standalone client's signed-contract email, still true to a link they
// can open cold). Every other email link in this codebase points at
// the frontend, which is right for a business owner viewing something
// inside their own dashboard, but wrong here. Must be set explicitly
// (e.g. https://tavzio-backend-supabase-production.up.railway.app) -
// deliberately no hardcoded fallback, since guessing wrong here means
// silently mailing a broken link instead of a clear "not configured".
function primaryApiUrl() {
  return (process.env.API_URL || '').split(',')[0].trim();
}

module.exports = { primaryClientUrl, primaryApiUrl };

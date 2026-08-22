// Server-side verification for Cloudflare Turnstile tokens. The widget
// on the frontend is only ever a UI signal - it produces a token that
// PROVES nothing on its own. The actual security boundary is this
// server call, which asks Cloudflare directly "was this token real and
// unused." Skipping this and trusting the frontend token blindly would
// make the whole feature decorative - anyone could just send an empty
// string or a stale token and bypass it entirely.
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Fails OPEN (returns true) when TURNSTILE_SECRET_KEY isn't configured,
// specifically so this doesn't lock everyone out of login the moment
// it's deployed before the env var is set. Once the secret is set, it
// fails CLOSED on any missing/invalid/reused token - the opposite
// default, and the one that actually matters once this is live.
async function verifyTurnstileToken(token, remoteIp) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true;
  if (!token) return false;

  try {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);

    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await res.json();
    return data.success === true;
  } catch {
    // A network failure talking to Cloudflare shouldn't be the reason a
    // real person can't log in - fails open on infrastructure errors,
    // same reasoning as the missing-secret case above, while still
    // failing closed on an actually invalid/missing token.
    return true;
  }
}

module.exports = { verifyTurnstileToken };

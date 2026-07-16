// NOT CURRENTLY USED. This project's JWT Signing Keys are set to
// asymmetric ECC (confirmed in Project Settings → JWT Signing Keys) —
// self-signing with a shared secret only works under the legacy HS256
// mode, which this project has moved away from. Kept here for reference:
// if you ever revoke back to the legacy secret, or implement JWKS-based
// verification (fetch the public key from /auth/v1/.well-known/jwks.json,
// verify ES256 locally with a library like `jose` — the correct fast-path
// for THIS project's actual configuration), this is the shape it'd take.
const jwt = require('jsonwebtoken');

// Builds a JWT with the exact claim shape Supabase's PostgREST/RLS layer
// expects (`role: authenticated`, `sub: <user id>`), signed with the
// project's own JWT secret. PostgREST verifies the signature and reads
// claims directly — it does NOT require a matching row in Supabase's own
// session table to accept the token for API calls, which is what makes
// self-signing safe for this use case.
//
// Deliberately has NO refresh token: tap-login sessions aren't meant to be
// silently refreshed forever. When one expires, the person just taps their
// card again — that tap *is* the re-authentication.
function signTapSession(user, { expiresInHours = 24 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: 'authenticated',
    role: 'authenticated',
    sub: user.id,
    email: user.email,
    aal: 'aal1',
    iat: now,
    exp: now + expiresInHours * 60 * 60,
  };
  return jwt.sign(payload, process.env.SUPABASE_JWT_SECRET);
}

module.exports = { signTapSession };

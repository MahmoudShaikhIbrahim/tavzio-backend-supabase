const { createClient } = require('@supabase/supabase-js');

// Bypasses RLS entirely. Use ONLY for: signup (creating business + profile
// together), and writing events from anonymous NFC taps/clicks where there's
// no logged-in user for RLS to key off of. Never expose this key or use it
// for anything a logged-in tenant should be doing themselves.
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Returns a client scoped to a specific user's JWT, so every query it makes
// runs through RLS as that user. This is what makes tenant isolation a
// database guarantee rather than something each route has to remember to check.
function supabaseForToken(accessToken) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Plain anon-key client, used only for the auth calls themselves
// (signUp / signInWithPassword) before we have a user token yet.
const supabasePublic = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

module.exports = { supabaseAdmin, supabaseForToken, supabasePublic };

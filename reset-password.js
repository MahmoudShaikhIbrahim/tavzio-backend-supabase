// One-off helper: sets a Supabase Auth user's password directly, using
// the admin API - no email, no confirmation link, no deployed domain
// needed. Uses the exact same service role key your backend already has
// in .env.
//
// USAGE (from the tavzio-backend-supabase folder):
//   node reset-password.js <email> <newPassword>
//
// Example:
//   node reset-password.js mahmoud@scripzio.com MyNewPass123!

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const [, , email, newPassword] = process.argv;

if (!email || !newPassword) {
  console.error('Usage: node reset-password.js <email> <newPassword>');
  process.exit(1);
}

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// A second, non-admin client - deliberately separate from supabaseAdmin -
// used only to immediately test the real sign-in path with the exact
// in-memory password string, closing the loop with proof instead of
// asking you to go check in a browser (where a typo or shell-quoting
// issue could introduce a brand new discrepancy).
const supabasePublic = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function run() {
  // Supabase's admin API needs the user's ID, not just their email - so
  // this looks the account up first, by paging through users until it
  // finds a matching email (the admin API doesn't have a direct
  // "get user by email" call).
  let user = null;
  let page = 1;
  while (!user) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    user = data.users.find((u) => u.email === email);
    if (user || data.users.length === 0) break;
    page += 1;
  }

  if (!user) {
    console.error(`No user found with email: ${email}`);
    process.exit(1);
  }

  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
    password: newPassword,
    email_confirm: true, // also force-confirms the account, in case that was ever the blocker too
  });

  if (updateError) throw updateError;

  console.log(`Password updated for ${email} (user id: ${user.id}).`);
  console.log('Testing sign-in with the exact same password now...');

  const { error: signInError } = await supabasePublic.auth.signInWithPassword({ email, password: newPassword });

  if (signInError) {
    console.error(`\nSelf-test FAILED: ${signInError.message}`);
    console.error('This means the password update itself did not take effect the way it should have -');
    console.error('this is a deeper issue than a typo or browser autofill, and worth flagging directly rather than retrying blindly.');
    process.exit(1);
  }

  console.log('\nSelf-test PASSED - this exact password genuinely works against Supabase, right now, proven.');
  console.log('If the browser still rejects it after this, the cause is on the browser/network side (rate-limiting,');
  console.log('a stale saved password, or a mismatch in what gets typed there) - not the account or the password itself.');
}

run().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});

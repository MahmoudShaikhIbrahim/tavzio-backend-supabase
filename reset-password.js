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

  console.log(`Password updated for ${email} (user id: ${user.id}). You can log in with the new password now.`);
}

run().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
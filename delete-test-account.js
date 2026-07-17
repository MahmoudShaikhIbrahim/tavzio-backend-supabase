// One-off helper: completely deletes a test business AND its owner's
// login account, for a genuinely clean slate - no leftover rows anywhere.
//
// What this actually removes:
//   1. The Supabase Auth user for the given email (this automatically
//      cascades to delete their `profiles` row too - profiles.id has an
//      ON DELETE CASCADE foreign key to auth.users.id).
//   2. The business row itself (this automatically cascades to delete
//      every card, order, menu item, loyalty record, payment, etc. tied
//      to it - every one of those tables references business_id with
//      ON DELETE CASCADE).
//
// USAGE (from the tavzio-backend-supabase folder):
//   node delete-test-account.js <ownerEmail> <businessSlug>
//
// Example:
//   node delete-test-account.js mahmoud@scripzio.com bella-pizza
//
// businessSlug is whatever comes after tavzio.com/ for that business -
// visible in its URL, or in super admin's business list.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const [, , email, slug] = process.argv;

if (!email || !slug) {
  console.error('Usage: node delete-test-account.js <ownerEmail> <businessSlug>');
  process.exit(1);
}

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function run() {
  // --- Delete the business (cascades cards/orders/menu/everything else) ---
  const { data: business, error: businessLookupError } = await supabaseAdmin
    .from('businesses')
    .select('id, name')
    .eq('slug', slug)
    .maybeSingle();
  if (businessLookupError) throw businessLookupError;

  if (business) {
    const { error: deleteBusinessError } = await supabaseAdmin.from('businesses').delete().eq('id', business.id);
    if (deleteBusinessError) throw deleteBusinessError;
    console.log(`Deleted business "${business.name}" (${slug}) and everything tied to it (cards, orders, menu, etc.).`);
  } else {
    console.log(`No business found with slug "${slug}" - skipping (maybe already deleted).`);
  }

  // --- Delete the Auth user (cascades their profile row automatically) ---
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
    console.log(`No auth account found with email "${email}" - skipping (maybe already deleted).`);
  } else {
    const { error: deleteUserError } = await supabaseAdmin.auth.admin.deleteUser(user.id);
    if (deleteUserError) throw deleteUserError;
    console.log(`Deleted auth account for ${email} (this also removed their profile row automatically).`);
  }

  console.log('\nDone - completely clean. You can create a brand new test business from scratch now.');
}

run().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});

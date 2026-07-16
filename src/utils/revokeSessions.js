const crypto = require('crypto');
const { supabaseAdmin } = require('../config/supabaseClient');

// Called whenever a card is disabled/reissued or a staff account is
// deactivated. The password itself is never used by anyone (admin accounts
// log in by tap or device-trust, not by typing a password) — this exists
// purely so changing it invalidates any session that was already issued
// before the disable, closing the "already-logged-in" gap that simply
// disabling the card or account doesn't cover on its own.
async function revokeSessionsFor(userId) {
  const randomPassword = crypto.randomBytes(32).toString('hex');
  const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    password: randomPassword,
  });
  if (error) console.error(`Failed to rotate password for ${userId}:`, error.message);
}

module.exports = { revokeSessionsFor };

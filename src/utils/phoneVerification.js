const { supabaseAdmin } = require('../config/supabaseClient');

// Shared, real proof that a phone number was actually verified via OTP
// for a given business - not a UI-only check the frontend could skip,
// since every caller of this queries the database directly.
//
// windowMinutes is optional and exists specifically because two
// genuinely different features need two different guarantees here:
// - Booking (and rescheduling, and "my bookings") needs proof the
//   phone was verified RECENTLY - a stale verification from weeks ago
//   shouldn't be enough to make a brand new reservation, since anyone
//   could still be holding that old, unattended session.
// - Loyalty needs the opposite: verify once, ever, on a given phone at
//   this business, and that's permanent proof going forward - the
//   whole point of "remember this device" is that a returning
//   customer's auto-checkin never re-prompts them, which a time
//   window would silently break the moment it expired.
// Passing no windowMinutes checks for a verified record at any time in
// the past; passing one restricts it to that many minutes ago.
async function isPhoneVerified(businessId, phone, windowMinutes) {
  let query = supabaseAdmin
    .from('booking_otp_codes')
    .select('id')
    .eq('business_id', businessId)
    .eq('phone', phone)
    .not('verified_at', 'is', null);
  if (windowMinutes) {
    query = query.gte('verified_at', new Date(Date.now() - windowMinutes * 60000).toISOString());
  }
  const { data: verified } = await query.order('verified_at', { ascending: false }).limit(1).maybeSingle();
  return !!verified;
}

module.exports = { isPhoneVerified };

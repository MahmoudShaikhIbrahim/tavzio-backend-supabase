const asyncHandler = require('../utils/asyncHandler');
const { supabaseAdmin } = require('../config/supabaseClient');
const { hashPin, verifyPin: checkHash } = require('../utils/pin');
const { logAction } = require('../utils/auditLog');

const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

function isValidPinFormat(pin) {
  return typeof pin === 'string' && /^\d{4,6}$/.test(pin);
}

// Reusable internal check - the payment endpoint (and, later, void/
// discount/refund) calls this directly rather than trusting an earlier
// /pin/verify call, so there's never a window between "PIN confirmed"
// and "sensitive action performed" that isn't itself guarded.
// Real lockout enforced here, not just in the standalone endpoint below -
// whichever path calls this gets the same protection.
async function checkPin(userId, pin) {
  if (!isValidPinFormat(pin)) return { ok: false, status: 400, message: 'PIN must be 4-6 digits' };

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('pin_hash, pin_failed_attempts, pin_locked_until')
    .eq('id', userId)
    .single();
  if (!profile) return { ok: false, status: 404, message: 'Account not found' };
  if (!profile.pin_hash) return { ok: false, status: 400, code: 'no_pin_set', message: 'No PIN set yet for this account' };

  if (profile.pin_locked_until && new Date(profile.pin_locked_until) > new Date()) {
    const minutesLeft = Math.ceil((new Date(profile.pin_locked_until) - new Date()) / 60000);
    return { ok: false, status: 423, message: `Too many wrong attempts - try again in ${minutesLeft} minute(s)` };
  }

  if (checkHash(pin, profile.pin_hash)) {
    if (profile.pin_failed_attempts > 0) {
      await supabaseAdmin.from('profiles').update({ pin_failed_attempts: 0, pin_locked_until: null }).eq('id', userId);
    }
    return { ok: true };
  }

  const attempts = (profile.pin_failed_attempts || 0) + 1;
  const update = { pin_failed_attempts: attempts };
  if (attempts >= MAX_ATTEMPTS) {
    update.pin_locked_until = new Date(Date.now() + LOCKOUT_MINUTES * 60000).toISOString();
    update.pin_failed_attempts = 0;
  }
  await supabaseAdmin.from('profiles').update(update).eq('id', userId);

  if (attempts >= MAX_ATTEMPTS) {
    return { ok: false, status: 423, message: `Too many wrong attempts - locked for ${LOCKOUT_MINUTES} minutes` };
  }
  return { ok: false, status: 401, message: `Wrong PIN (${MAX_ATTEMPTS - attempts} attempt(s) left)` };
}

// @route POST /api/auth/pin
// Self-service, always on your OWN account (req.user.id) - setting a PIN
// is a choice a staff member makes for themselves the first time they
// need one, same reasoning a password isn't set on someone else's
// behalf. Changing an EXISTING PIN requires the current one, same
// convention as a password change even while already logged in.
const setPin = asyncHandler(async (req, res) => {
  const { pin, currentPin } = req.body;
  if (!isValidPinFormat(pin)) return res.status(400).json({ message: 'PIN must be 4-6 digits' });

  const { data: profile } = await supabaseAdmin.from('profiles').select('pin_hash').eq('id', req.user.id).single();
  if (profile?.pin_hash) {
    if (!currentPin || !checkHash(currentPin, profile.pin_hash)) {
      return res.status(401).json({ message: 'Current PIN is incorrect' });
    }
  }

  await supabaseAdmin
    .from('profiles')
    .update({ pin_hash: hashPin(pin), pin_set_at: new Date().toISOString(), pin_failed_attempts: 0, pin_locked_until: null })
    .eq('id', req.user.id);

  res.json({ message: 'PIN set' });
});

// @route POST /api/auth/pin/verify
// The frontend's own confirm-PIN UX step (so it can show "checking..."
// and move to the tender screen only once confirmed) - the actual
// sensitive action re-checks independently via checkPin() above, this
// endpoint alone never authorizes anything by itself.
const verifyPinEndpoint = asyncHandler(async (req, res) => {
  const result = await checkPin(req.user.id, req.body.pin);
  if (!result.ok) return res.status(result.status).json({ message: result.message, code: result.code });
  res.json({ verified: true });
});

// @route DELETE /api/businesses/:businessId/staff/:userId/pin
// Owner clears a forgotten PIN - deliberately clears rather than sets a
// known replacement value, so the owner never learns or chooses that
// staff member's new PIN; they set their own next time they need one,
// same as a forgotten-password reset sends a link rather than handing
// back a password someone else picked.
const clearStaffPin = asyncHandler(async (req, res) => {
  const { data: target } = await supabaseAdmin
    .from('profiles')
    .select('id, name')
    .eq('id', req.params.userId)
    .eq('business_id', req.params.businessId)
    .maybeSingle();
  if (!target) return res.status(404).json({ message: 'Staff member not found' });

  await supabaseAdmin
    .from('profiles')
    .update({ pin_hash: null, pin_set_at: null, pin_failed_attempts: 0, pin_locked_until: null })
    .eq('id', target.id);

  await logAction({
    businessId: req.params.businessId,
    actor: req.user,
    action: 'staff_pin_reset',
    targetId: target.id,
    details: { accountName: target.name },
  });

  res.json({ message: 'PIN cleared - they can set a new one next time they need it' });
});

module.exports = { setPin, verifyPinEndpoint, clearStaffPin, checkPin };

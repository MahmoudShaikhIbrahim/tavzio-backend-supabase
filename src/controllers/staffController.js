const { supabaseAdmin } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { revokeSessionsFor } = require('../utils/revokeSessions');

// @route POST /api/businesses/:businessId/staff
// Creates a staff account (Supabase Auth user + profile row via the
// handle_new_user trigger), linked to this business, via Supabase's real
// invite-by-email flow. This sends the staff member an actual email
// letting THEM set their own password - we never generate or see it.
// Whether that password ever gets used depends entirely on this
// business's features.accessMethods.website toggle: if card-only, the
// staff member can simply ignore the invite email and use their tap card;
// if website access is (or later becomes) enabled, the same account
// already has a real, working password ready to go - no separate step
// needed later.
const inviteStaff = asyncHandler(async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ message: 'name and email are required' });

  const { data: created, error: createError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
    data: { name, role: 'staff' },
  });
  if (createError) return res.status(400).json({ message: createError.message });

  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .update({ business_id: req.params.businessId })
    .eq('id', created.user.id);
  if (profileError) return res.status(400).json({ message: profileError.message });

  res.status(201).json({ id: created.user.id, name, email, role: 'staff' });
});

// @route GET /api/businesses/:businessId/staff
const listStaff = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('profiles')
    .select('id, name, role, is_active, last_login_at, created_at')
    .eq('business_id', req.params.businessId)
    .in('role', ['staff', 'business_owner']);

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route PATCH /api/businesses/:businessId/staff/:userId
// Body: { isActive: bool } — deactivating blocks BOTH tap-login and normal
// password login immediately (checked in the `protect` middleware and in
// resolveCardTap), independent of whether their card is separately disabled.
const setStaffActive = asyncHandler(async (req, res) => {
  const { isActive } = req.body;

  const { data, error } = await req.supabase
    .from('profiles')
    .update({ is_active: !!isActive })
    .eq('id', req.params.userId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ message: 'Staff member not found' });

  if (!isActive) await revokeSessionsFor(req.params.userId);

  res.json(data);
});

module.exports = { inviteStaff, listStaff, setStaffActive };

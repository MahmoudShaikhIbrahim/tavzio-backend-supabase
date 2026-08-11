const { supabaseAdmin } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { revokeSessionsFor } = require('../utils/revokeSessions');
const { logAction } = require('../utils/auditLog');
const crypto = require('crypto');

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
  const { name, email, jobRole } = req.body;
  if (!name || !email) return res.status(400).json({ message: 'name and email are required' });

  const { data: created, error: createError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
    data: { name, role: 'staff' },
  });
  if (createError) return res.status(400).json({ message: createError.message });

  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .update({ business_id: req.params.businessId, job_role: jobRole || null })
    .eq('id', created.user.id);
  if (profileError) return res.status(400).json({ message: profileError.message });

  res.status(201).json({ id: created.user.id, name, email, role: 'staff', jobRole: jobRole || null });
});

// @route GET /api/businesses/:businessId/staff
const listStaff = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('profiles')
    .select('id, name, role, job_role, is_active, last_login_at, created_at')
    .eq('business_id', req.params.businessId)
    .in('role', ['staff', 'business_owner']);

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route PATCH /api/businesses/:businessId/staff/:userId/job-role
// Body: { jobRole }
// Only relevant for businesses using the granular hotel-context roles -
// a restaurant/cafe staff account can simply leave this unset and
// nothing changes for them.
const setStaffJobRole = asyncHandler(async (req, res) => {
  const { jobRole } = req.body;
  const { data, error } = await req.supabase
    .from('profiles')
    .update({ job_role: jobRole || null })
    .eq('id', req.params.userId)
    .eq('business_id', req.params.businessId)
    .eq('role', 'staff')
    .select('id, name, job_role')
    .single();
  if (error || !data) return res.status(404).json({ message: 'Staff member not found' });
  res.json(data);
});

// @route GET /api/role-permissions
// The available job roles and what each can do - lets the frontend
// build a real role picker and show what a role actually grants, rather
// than a hardcoded guess of what exists.
const listRolePermissions = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase.from('role_permissions').select('*').order('label');
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

// @route POST /api/businesses/:businessId/staff/:userId/reset-password
// (super_admin or business_owner only)
// The actual fix for "an onboarded owner/staff member is locked out and
// nobody can get back in" - there was previously no path for this at
// all. Generates a real new temporary password directly via the
// Supabase Admin API (the same mechanism used at account creation), and
// forces them to set their own on next login - closes the "someone
// else knows my password" loop the same way first-login already does,
// rather than leaving a reset password in circulation indefinitely.
const resetPassword = asyncHandler(async (req, res) => {
  const { data: profile } = await req.supabase
    .from('profiles')
    .select('id, name, role')
    .eq('id', req.params.userId)
    .eq('business_id', req.params.businessId)
    .single();
  if (!profile) return res.status(404).json({ message: 'Account not found' });

  const tempPassword = crypto.randomBytes(9).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 12);

  const { error: authError } = await supabaseAdmin.auth.admin.updateUserById(profile.id, { password: tempPassword });
  if (authError) return res.status(400).json({ message: authError.message });

  await supabaseAdmin.from('profiles').update({ must_change_password: true }).eq('id', profile.id);

  await logAction({
    businessId: req.params.businessId,
    actor: req.user,
    action: 'password_reset',
    targetId: profile.id,
    details: { accountName: profile.name, role: profile.role },
  });

  res.json({ tempPassword, name: profile.name });
});

module.exports = { inviteStaff, listStaff, setStaffActive, setStaffJobRole, listRolePermissions, resetPassword };

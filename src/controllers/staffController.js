const { supabaseAdmin } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { revokeSessionsFor } = require('../utils/revokeSessions');
const { logAction } = require('../utils/auditLog');
const { sendNewInviteEmail, resendInviteEmail } = require('../utils/notifications');
const crypto = require('crypto');

// @route POST /api/businesses/:businessId/staff
// Creates a staff account (Supabase Auth user + profile row via the
// handle_new_user trigger), linked to this business, via a real
// invite-by-email flow. This sends the staff member an actual email
// letting THEM set their own password - we never generate or see it.
// Whether that password ever gets used depends entirely on this
// business's features.accessMethods.website toggle: if card-only, the
// staff member can simply ignore the invite email and use their tap card;
// if website access is (or later becomes) enabled, the same account
// already has a real, working password ready to go - no separate step
// needed later.
const inviteStaff = asyncHandler(async (req, res) => {
  const { name, email, jobRole, sections } = req.body;
  if (!name || !email) return res.status(400).json({ message: 'name and email are required' });
  if (sections !== undefined && sections !== null && !Array.isArray(sections)) {
    return res.status(400).json({ message: 'sections must be an array or null' });
  }

  const { data: business } = await supabaseAdmin.from('businesses').select('name').eq('id', req.params.businessId).maybeSingle();
  const redirectTo = `${process.env.CLIENT_URL}/admin/login`;

  // Real fix, confirmed on two separate counts: this used to call
  // Supabase's own inviteUserByEmail(), which (a) without redirectTo
  // explicitly set, fell back to whatever "Site URL" is configured in
  // Supabase's OWN dashboard settings rather than this app's CLIENT_URL
  // - which was still the localhost placeholder, so the link was dead -
  // and (b) always sent via Supabase's own mailer, so the email showed
  // up looking like it came from Supabase, not Tavzio, and shared
  // Supabase's own strict send-rate limit with every other project on
  // the account. sendNewInviteEmail (see notifications.js) generates
  // the link without Supabase ever sending anything, then sends the
  // actual email via Resend on Tavzio's own verified domain - both
  // problems fixed by the same change.
  let created;
  try {
    created = await sendNewInviteEmail({
      email, name, businessLabel: business?.name || 'Tavzio', redirectTo,
      userMetadata: { name, role: 'staff' },
    });
  } catch (createError) {
    // Real fix: clicking "Add staff" a second time for someone who
    // never checked their first email used to just fail outright -
    // "already registered" - with no way to actually get them a
    // working link short of asking a super_admin to intervene.
    // Detecting this specific error and falling back to a real resend
    // makes the same "Add staff" button double as "resend," which is
    // what an owner clicking it a second time actually means in
    // practice.
    if (createError.message && createError.message.toLowerCase().includes('already been registered')) {
      const { data: existing } = await supabaseAdmin.auth.admin.listUsers();
      const existingUser = existing?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
      if (!existingUser) return res.status(400).json({ message: createError.message });

      await supabaseAdmin
        .from('profiles')
        .update({ business_id: req.params.businessId, job_role: jobRole || null, assigned_sections: sections ?? null })
        .eq('id', existingUser.id);

      await resendInviteEmail({ email, name, businessLabel: business?.name || 'Tavzio', redirectTo });

      return res.status(200).json({ id: existingUser.id, name, email, role: 'staff', jobRole: jobRole || null, resent: true });
    }
    return res.status(400).json({ message: createError.message });
  }

  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .update({ business_id: req.params.businessId, job_role: jobRole || null, assigned_sections: sections ?? null })
    .eq('id', created.id);
  if (profileError) return res.status(400).json({ message: profileError.message });

  res.status(201).json({ id: created.id, name, email, role: 'staff', jobRole: jobRole || null, assigned_sections: sections ?? null });
});

// @route GET /api/businesses/:businessId/staff
const listStaff = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('profiles')
    .select('id, name, role, job_role, is_active, last_login_at, created_at, assigned_sections, assigned_outlet_ids, full_access, nav_layout, organization_id, avatar_url')
    .eq('business_id', req.params.businessId)
    .in('role', ['staff', 'business_owner', 'org_owner']);

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

// @route PATCH /api/businesses/:businessId/staff/:userId/sections
// Body: { sections: string[] | null }
// Restricts (or, with null, un-restricts) which dashboard sections this
// staff account can see - a real account-level setting checked by the
// frontend nav on every load, not a one-time UI hint. Multiple people
// can still be logged into the same account at once from different
// devices exactly as before; this only shapes what that account sees,
// same for everyone using it.
const setStaffSections = asyncHandler(async (req, res) => {
  const { sections } = req.body;
  if (sections !== null && !Array.isArray(sections)) {
    return res.status(400).json({ message: 'sections must be an array or null' });
  }
  const { data, error } = await req.supabase
    .from('profiles')
    .update({ assigned_sections: sections })
    .eq('id', req.params.userId)
    .eq('business_id', req.params.businessId)
    .eq('role', 'staff')
    .select('id, name, assigned_sections')
    .single();
  if (error || !data) return res.status(404).json({ message: 'Staff member not found' });
  res.json(data);
});

// @route PATCH /api/businesses/:businessId/staff/:userId/outlets
// Body: { outletIds: string[] | null }
// Hotel-only in practice - which specific outlet(s) this staff account
// may open a till against. null (default) = unrestricted, same
// backward-compatible convention as assigned_sections. This is what
// makes "the beach attendant can't accidentally open the lobby till"
// a real, server-enforced fact (checked in tillController's openTill),
// not just a UI suggestion.
const setStaffOutlets = asyncHandler(async (req, res) => {
  const { outletIds } = req.body;
  if (outletIds !== null && !Array.isArray(outletIds)) {
    return res.status(400).json({ message: 'outletIds must be an array or null' });
  }
  const { data, error } = await req.supabase
    .from('profiles')
    .update({ assigned_outlet_ids: outletIds })
    .eq('id', req.params.userId)
    .eq('business_id', req.params.businessId)
    .eq('role', 'staff')
    .select('id, name, assigned_outlet_ids')
    .single();
  if (error || !data) return res.status(404).json({ message: 'Staff member not found' });
  res.json(data);
});

// @route PATCH /api/businesses/:businessId/staff/:userId/full-access
// Body: { fullAccess: boolean }
// Grants (or revokes) owner-equivalent access to a specific staff
// account - Manager, CEO, CFO, whoever the owner delegates to. This is
// a real, server-enforced capability (see authorize() and
// current_role_name() in the backend), not a cosmetic label: a
// full_access account passes every existing business_owner-gated check
// across the whole app, both at the route level and in RLS. Restricted
// to owner accounts here (not full_access staff granting it onward to
// someone else) - deliberately a one-level delegation the actual owner
// controls, not something a delegate can further hand out themselves.
const setStaffFullAccess = asyncHandler(async (req, res) => {
  const { fullAccess } = req.body;
  if (typeof fullAccess !== 'boolean') {
    return res.status(400).json({ message: 'fullAccess must be true or false' });
  }
  if (req.user.role !== 'business_owner' && req.user.role !== 'super_admin') {
    return res.status(403).json({ message: 'Only the business owner can grant full access' });
  }
  const { data, error } = await req.supabase
    .from('profiles')
    .update({ full_access: fullAccess })
    .eq('id', req.params.userId)
    .eq('business_id', req.params.businessId)
    .eq('role', 'staff')
    .select('id, name, full_access')
    .single();
  if (error || !data) return res.status(404).json({ message: 'Staff member not found' });

  await logAction({
    businessId: req.params.businessId,
    actor: req.user,
    action: fullAccess ? 'full_access_granted' : 'full_access_revoked',
    targetId: data.id,
    details: { accountName: data.name },
  });

  res.json(data);
});

// @route PATCH /api/businesses/:businessId/staff/:userId/nav-layout
// Body: { hidden: string[], order: string[], pinned?: string[] } | null
// Per-person dashboard tab customization - hide/reorder, plus which
// Settings pages (if any) are pinned onto the main dashboard tab row
// instead of living only inside the Settings list. Deliberately
// self-service: unlike sections/outlets/full-access (which only an
// owner can set on someone else), a person sets this on THEIR OWN
// account only (enforced by matching :userId against req.user.id, not
// business-owner-only like the others), since it's a personal layout
// preference, not an access control.
const setMyNavLayout = asyncHandler(async (req, res) => {
  if (req.params.userId !== req.user.id) {
    return res.status(403).json({ message: 'You can only change your own nav layout' });
  }
  const { hidden, order, pinned } = req.body;
  const layout = (hidden === null && order === null) ? null : {
    hidden: Array.isArray(hidden) ? hidden : [],
    order: Array.isArray(order) ? order : [],
    pinned: Array.isArray(pinned) ? pinned : [],
  };
  const { data, error } = await req.supabase
    .from('profiles')
    .update({ nav_layout: layout })
    .eq('id', req.user.id)
    .select('id, nav_layout')
    .single();
  if (error || !data) return res.status(400).json({ message: error?.message || 'Could not save layout' });
  res.json(data);
});

// @route PATCH /api/businesses/:businessId/staff/:userId/avatar
// Body: { avatarUrl: string | null }
// Self-service, exactly like nav-layout above: an account sets its own
// picture only (never someone else's, even an owner setting a staff
// member's photo for them) - :userId always has to be the caller's own
// id. The actual file already lives in Supabase Storage by the time this
// runs (uploaded client-side the same way menu photos are); this just
// records the resulting URL against the profile.
const setMyAvatar = asyncHandler(async (req, res) => {
  if (req.params.userId !== req.user.id) {
    return res.status(403).json({ message: 'You can only change your own picture' });
  }
  const { avatarUrl } = req.body;
  const { data, error } = await req.supabase
    .from('profiles')
    .update({ avatar_url: avatarUrl || null })
    .eq('id', req.user.id)
    .select('id, avatar_url')
    .single();
  if (error || !data) return res.status(400).json({ message: error?.message || 'Could not save picture' });
  res.json(data);
});

// @route DELETE /api/businesses/:businessId/staff/:userId
// Real, permanent removal - distinct from setStaffActive's deactivate
// toggle (which keeps the account and its history, just blocks login).
// This deletes the auth user outright, which cascades to the profile
// row (profiles.id references auth.users(id) on delete cascade) and
// therefore everything scoped to that profile id. Owner/full-access
// only, and can't be used to delete yourself or another business_owner
// account - an owner removing their own access, or one owner removing
// another, is a business-transfer scenario this button isn't for.
//
// org_owner rows are deletable here too, but only self-service ones:
// the .eq('business_id', ...) below already excludes a super_admin-
// created, multi-business org_owner (business_id is null for those, by
// design - see migration 0051/0096) before role is even checked, so
// this can never reach across a real multi-tenant franchise link.
// Deleting an org_owner intentionally leaves the organization row and
// businesses.organization_id link untouched - unwinding the org itself
// (and anything shared through it - suppliers, POs, published menus) is
// a separate, explicit decision this button doesn't make on its own.
const deleteStaff = asyncHandler(async (req, res) => {
  const { data: target } = await req.supabase
    .from('profiles')
    .select('id, name, role')
    .eq('id', req.params.userId)
    .eq('business_id', req.params.businessId)
    .maybeSingle();
  if (!target) return res.status(404).json({ message: 'Staff member not found' });
  if (target.id === req.user.id) return res.status(400).json({ message: 'You cannot delete your own account' });
  if (target.role !== 'staff' && target.role !== 'org_owner') {
    return res.status(400).json({ message: 'Only staff or org owner accounts can be deleted here' });
  }

  await revokeSessionsFor(target.id);

  const { error } = await supabaseAdmin.auth.admin.deleteUser(target.id);
  if (error) return res.status(400).json({ message: error.message });

  await logAction({
    businessId: req.params.businessId,
    actor: req.user,
    action: target.role === 'org_owner' ? 'org_owner_deleted' : 'staff_deleted',
    targetId: target.id,
    details: { accountName: target.name },
  });

  res.json({ message: 'Staff account deleted', id: target.id });
});

// @route POST /api/businesses/:businessId/staff/:userId/resend-invite
// The other entry point for the same resend logic in inviteStaff above -
// this one for a staff member who's already listed (so their email
// isn't sitting in a form anymore, it needs looking up from auth.users)
// rather than someone re-typing the whole add-staff form to trigger it.
const resendStaffInvite = asyncHandler(async (req, res) => {
  const { data: profile } = await req.supabase
    .from('profiles')
    .select('id, name')
    .eq('id', req.params.userId)
    .eq('business_id', req.params.businessId)
    .maybeSingle();
  if (!profile) return res.status(404).json({ message: 'Staff member not found' });

  const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.getUserById(profile.id);
  if (authError || !authUser?.user?.email) return res.status(404).json({ message: 'Could not find this account\'s email' });

  const { data: business } = await supabaseAdmin.from('businesses').select('name').eq('id', req.params.businessId).maybeSingle();

  await resendInviteEmail({
    email: authUser.user.email,
    name: profile.name,
    businessLabel: business?.name || 'Tavzio',
    redirectTo: `${process.env.CLIENT_URL}/admin/login`,
  });

  res.json({ message: 'Invite resent' });
});

module.exports = { inviteStaff, resendStaffInvite, listStaff, setStaffActive, deleteStaff, setStaffJobRole, setStaffSections, setStaffOutlets, setStaffFullAccess, setMyNavLayout, setMyAvatar, listRolePermissions, resetPassword };

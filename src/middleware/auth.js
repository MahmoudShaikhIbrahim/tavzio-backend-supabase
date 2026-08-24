const { supabaseAdmin, supabaseForToken } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');

// Verifies the token via Supabase's own Auth API. This project uses
// asymmetric JWT signing keys (ECC), not the legacy shared HS256 secret —
// so tokens can only be verified correctly by Supabase itself (or via its
// public JWKS, which is a future optimization) — not by re-signing/checking
// locally with a shared secret. Confirmed via Project Settings → JWT
// Signing Keys showing "ECC (P-256)" as the current key.
const protect = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Not authorized, no token' });
  }
  const token = header.split(' ')[1];

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ message: 'Not authorized, token invalid or expired' });
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('id, name, role, business_id, organization_id, is_active, theme_preference, preferred_language, must_change_password, job_role, assigned_sections, assigned_outlet_ids, full_access, is_org_owner, nav_layout, tour_completed_at')
    .eq('id', data.user.id)
    .single();

  if (profileError || !profile || !profile.is_active) {
    return res.status(401).json({ message: 'Not authorized, profile not found or inactive' });
  }

  req.user = { ...profile, email: data.user.email };
  req.token = token;
  req.supabase = supabaseForToken(token); // RLS-scoped — use this in controllers
  next();
});

// Restricts a route to specific roles, e.g. authorize('super_admin').
// A staff account with full_access=true passes any check that includes
// 'business_owner' in its allowed list - this is the single place that
// makes delegated full access real across every owner-gated route in
// the app, rather than something that would need updating route by
// route. It never grants super_admin - only business_owner-equivalence.
const authorize = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(403).json({ message: 'Forbidden: insufficient role' });
  const passes = roles.includes(req.user.role)
    || (req.user.full_access && roles.includes('business_owner'));
  if (!passes) {
    return res.status(403).json({ message: 'Forbidden: insufficient role' });
  }
  next();
};

// This is now a convenience check for a fast, clear 403 — RLS is the real
// enforcement underneath. Even if this were accidentally removed from a
// route, req.supabase queries still can't cross tenants.
const enforceTenant = (req, res, next) => {
  if (req.user.role === 'super_admin') return next();

  const targetBusinessId = req.params.businessId || req.body.business_id;
  if (!req.user.business_id || String(req.user.business_id) !== String(targetBusinessId)) {
    return res.status(403).json({ message: 'Forbidden: cross-tenant access denied' });
  }
  next();
};

// Real, backend-enforced permission checks for hotel-context staff
// roles (front_desk, waiter, housekeeping, etc) - not a UI-only gate.
// super_admin and business_owner always pass: an owner has implicit
// full access to their own business by definition, and never needs a
// job_role or a permissions lookup at all - only `staff` accounts get
// checked against their specific job_role's permission set.
const requirePermission = (permissionKey) => async (req, res, next) => {
  if (!req.user) return res.status(401).json({ message: 'Not authorized' });
  if (req.user.role === 'super_admin' || req.user.role === 'business_owner' || req.user.full_access) return next();

  if (req.user.role !== 'staff' || !req.user.job_role) {
    return res.status(403).json({ message: `Forbidden: missing permission "${permissionKey}"` });
  }

  const { data: roleDef } = await supabaseAdmin
    .from('role_permissions')
    .select('permissions')
    .eq('role_key', req.user.job_role)
    .maybeSingle();

  const permissions = roleDef?.permissions || [];
  if (!permissions.includes(permissionKey)) {
    return res.status(403).json({ message: `Forbidden: your role (${req.user.job_role}) doesn't include "${permissionKey}"` });
  }
  next();
};

module.exports = { protect, authorize, enforceTenant, requirePermission };

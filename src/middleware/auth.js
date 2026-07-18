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
    .select('id, name, role, business_id, is_active, theme_preference')
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

// Restricts a route to specific roles, e.g. authorize('super_admin')
const authorize = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
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

module.exports = { protect, authorize, enforceTenant };

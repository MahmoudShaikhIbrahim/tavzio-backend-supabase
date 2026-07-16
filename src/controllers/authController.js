const { supabaseAdmin, supabasePublic } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const crypto = require('crypto');

// @route POST /api/auth/register
// Creates the Supabase Auth user (which triggers the profiles row via the
// DB trigger), then creates the business and links profile.business_id.
// The business/profile-link step uses the admin client since it spans two
// tables as one logical operation and RLS would otherwise block a brand new
// user (with no business yet) from creating one.
const register = asyncHandler(async (req, res) => {
  const { name, email, password, businessName, slug, category } = req.body;

  if (!name || !email || !password || !businessName || !slug) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  const { data: existingSlug } = await supabaseAdmin
    .from('businesses')
    .select('id')
    .eq('slug', slug.toLowerCase())
    .maybeSingle();
  if (existingSlug) {
    return res.status(409).json({ message: 'That business URL is already taken' });
  }

  const { data: signUpData, error: signUpError } = await supabasePublic.auth.signUp({
    email,
    password,
    options: { data: { name, role: 'business_owner' } },
  });

  if (signUpError) {
    return res.status(400).json({ message: signUpError.message });
  }

  const userId = signUpData.user.id;

  const { data: business, error: businessError } = await supabaseAdmin
    .from('businesses')
    .insert({
      name: businessName,
      slug: slug.toLowerCase(),
      category: category || 'other',
      owner: userId,
      status: 'pending',
    })
    .select()
    .single();

  if (businessError) {
    return res.status(400).json({ message: businessError.message });
  }

  await supabaseAdmin
    .from('profiles')
    .update({ business_id: business.id })
    .eq('id', userId);

  res.status(201).json({
    message: signUpData.session
      ? 'Registered successfully'
      : 'Registered — check your email to confirm your account',
    user: { id: userId, name, email },
    business: { id: business.id, slug: business.slug, name: business.name },
    session: signUpData.session, // null if email confirmation is required
  });
});

// @route POST /api/auth/login
// super_admin always allowed (not tied to any business). Owners/staff are
// allowed ONLY if their business has features.accessMethods.website
// enabled - a per-business, super_admin-controlled entitlement, not a
// blanket rule either way. This still closes the original gap (a real
// password or a password-reset silently bypassing every tap-card
// protection) for any business that hasn't been granted website access -
// it just no longer assumes NO business ever wants this.
const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password required' });
  }

  const { data, error } = await supabasePublic.auth.signInWithPassword({ email, password });
  if (error) {
    return res.status(401).json({ message: error.message });
  }

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role, business_id')
    .eq('id', data.user.id)
    .single();

  let allowed = false;
  if (profile?.role === 'super_admin') {
    allowed = true;
  } else if (profile?.role && profile.business_id) {
    const { data: business } = await supabaseAdmin
      .from('businesses')
      .select('features')
      .eq('id', profile.business_id)
      .single();
    allowed = !!business?.features?.accessMethods?.website;
  }

  if (!allowed) {
    // A valid session was just created by signInWithPassword - explicitly
    // sign it out rather than silently letting it expire, so nothing
    // usable is left behind even though we never hand it to the caller.
    await supabasePublic.auth.signOut();
    return res.status(403).json({
      message: 'Website login is not enabled for this account. Use your tap card, or contact the platform operator.',
    });
  }

  await supabaseAdmin
    .from('profiles')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', data.user.id);

  res.json({
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at,
    user: { id: data.user.id, email: data.user.email },
  });
});

// @route POST /api/auth/refresh
const refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(401).json({ message: 'Refresh token required' });

  const { data, error } = await supabasePublic.auth.refreshSession({ refresh_token: refreshToken });
  if (error) return res.status(401).json({ message: error.message });

  res.json({
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
    expiresAt: data.session.expires_at,
  });
});

// @route GET /api/auth/me
const me = asyncHandler(async (req, res) => {
  res.json(req.user); // populated by the `protect` middleware from `profiles`
});

// @route GET /api/auth/confirm-device/:pendingId
// Opened from the confirmation email link, on the same device that
// triggered it. Marks the device trusted for next time and completes login.
const confirmDevice = asyncHandler(async (req, res) => {
  const { data: pending, error } = await supabaseAdmin
    .from('pending_device_confirmations')
    .select('*')
    .eq('id', req.params.pendingId)
    .single();

  if (error || !pending) return res.status(404).json({ message: 'Confirmation not found' });
  if (pending.status !== 'pending') {
    return res.status(400).json({ message: 'This confirmation link was already used' });
  }
  if (new Date(pending.expires_at) < new Date()) {
    await supabaseAdmin.from('pending_device_confirmations').update({ status: 'expired' }).eq('id', pending.id);
    return res.status(400).json({ message: 'This confirmation link expired — please tap the card again' });
  }

  await supabaseAdmin
    .from('pending_device_confirmations')
    .update({ status: 'confirmed' })
    .eq('id', pending.id);

  const deviceToken = crypto.randomUUID();
  await supabaseAdmin.from('trusted_devices').insert({
    user_id: pending.user_id,
    device_token: deviceToken,
    label: req.headers['user-agent'] || '',
  });

  const { data: profile } = await supabaseAdmin.from('profiles').select('role').eq('id', pending.user_id).single();
  const { data: user } = await supabaseAdmin.auth.admin.getUserById(pending.user_id);

  const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: user.user.email,
  });
  if (linkError) return res.status(500).json({ message: linkError.message });

  const { data: sessionData, error: verifyError } = await supabasePublic.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink',
  });
  if (verifyError) return res.status(500).json({ message: verifyError.message });

  res.json({
    redirect: '/admin/dashboard',
    role: profile?.role,
    accessToken: sessionData.session.access_token,
    refreshToken: sessionData.session.refresh_token,
    deviceToken, // frontend stores this (e.g. localStorage) and sends it as X-Device-Token on future taps
  });
});

module.exports = { register, login, refresh, me, confirmDevice };

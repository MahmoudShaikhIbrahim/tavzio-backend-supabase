const { supabaseAdmin, supabasePublic } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { verifyTurnstileToken } = require('../utils/turnstile');
const { logAction } = require('../utils/auditLog');
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
    .update({ business_id: business.id, must_change_password: true })
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
  const { email, password, turnstileToken } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password required' });
  }

  // Verified before touching Supabase Auth at all - a bot's credential-
  // stuffing attempt gets rejected here, before it ever gets a chance to
  // burn a real password-check against a real account.
  const humanVerified = await verifyTurnstileToken(turnstileToken, req.ip);
  if (!humanVerified) {
    return res.status(400).json({ message: 'Verification failed - please try again.' });
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

  // Real requirement: only one active session per account, anywhere -
  // logging in on a second tab/device must sign the first one out
  // automatically, not just let both sit open. This is Supabase Auth's
  // own built-in scoped sign-out (scope: 'others'), not a hand-rolled
  // session table - it revokes the access AND refresh token for every
  // OTHER session tied to this account, using the brand-new session's
  // own token to identify "this one, keep it" vs everything else.
  // Enforcement is real (the other tab's token is genuinely dead at
  // Supabase's end), even though the other tab won't visibly redirect
  // to login until its next request - useSession's existing 20s cache
  // cycle and authFetch's existing 401-refresh-fail-redirect logic
  // (both already in the frontend) are what make that happen, with no
  // frontend changes needed for this.
  await supabaseAdmin.auth.admin.signOut(data.session.access_token, 'others').catch((err) => {
    console.error('Could not revoke other sessions on login:', err.message);
  });

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

// @route PATCH /api/auth/theme
// Body: { theme: 'light' | 'dark' | 'system' }
// Scoped to the caller's own account only - nobody can set anyone else's.
const updateMyTheme = asyncHandler(async (req, res) => {
  const { theme } = req.body;
  if (!['light', 'dark', 'system'].includes(theme)) {
    return res.status(400).json({ message: 'Invalid theme' });
  }

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .update({ theme_preference: theme })
    .eq('id', req.user.id)
    .select('id, name, role, business_id, is_active, theme_preference')
    .single();

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route PATCH /api/auth/tour
// Body: { completed: boolean } - true when finished or explicitly
// skipped (both stop the auto-open, per the migration 0084 comment);
// false is what "Restart guide" in Business Profile sends to clear it
// back to NULL and make the tour auto-open again on next login.
const updateMyTour = asyncHandler(async (req, res) => {
  const { completed } = req.body;
  if (typeof completed !== 'boolean') {
    return res.status(400).json({ message: 'completed must be true or false' });
  }
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .update({ tour_completed_at: completed ? new Date().toISOString() : null })
    .eq('id', req.user.id)
    .select('id, tour_completed_at')
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// Scoped to the caller's own account only - nobody can set anyone else's.
// Same 9 languages as the customer-facing NFC interface, so an owner or
// staff member gets a language switcher they already recognize.
const updateMyLanguage = asyncHandler(async (req, res) => {
  const { language } = req.body;
  const VALID_LANGUAGES = ['en', 'ar', 'ru', 'es', 'hi', 'ur', 'tl', 'zh', 'fr'];
  if (!VALID_LANGUAGES.includes(language)) {
    return res.status(400).json({ message: 'Invalid language' });
  }

  const { data, error } = await supabaseAdmin
    .from('profiles')
    .update({ preferred_language: language })
    .eq('id', req.user.id)
    .select('id, name, role, business_id, is_active, theme_preference, preferred_language')
    .single();

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
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

// @route PATCH /api/auth/change-password
// Body: { currentPassword, newPassword }
// Used both for the forced first-login change (owner accounts start
// with must_change_password=true, since the super admin set that
// original password directly and knows it) and for a voluntary change
// anytime after. Verifying the current password first (via a real
// sign-in attempt) matters even though the user is already
// authenticated - it stops someone on an already-unlocked device from
// silently taking over the account's password.
const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ message: 'currentPassword and newPassword are required' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ message: 'New password must be at least 8 characters' });
  }

  const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(req.user.id);
  const email = authUser?.user?.email;
  if (!email) return res.status(400).json({ message: 'Could not verify your account' });

  const { error: verifyError } = await supabasePublic.auth.signInWithPassword({ email, password: currentPassword });
  if (verifyError) return res.status(401).json({ message: 'Current password is incorrect' });

  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, { password: newPassword });
  if (updateError) return res.status(400).json({ message: updateError.message });

  await supabaseAdmin.from('profiles').update({ must_change_password: false }).eq('id', req.user.id);

  res.json({ message: 'Password updated' });
});

// @route PATCH /api/auth/email
// Body: { currentPassword, newEmail }
// Same security discipline as changePassword above: verifying the
// current password first (a real sign-in attempt) stops someone on an
// already-unlocked device from silently taking over the account's
// email - and by extension, every future password reset, which goes to
// whatever email is on file. Uses the admin client to set the new
// email directly and immediately, matching how password changes here
// already work (no separate confirmation-link dance), rather than
// relying on Supabase Auth's built-in dual-email-confirmation flow,
// which would need its own email delivery setup distinct from the
// Gmail-based sender this app already uses for everything else.
const changeMyEmail = asyncHandler(async (req, res) => {
  const { currentPassword, newEmail } = req.body;
  if (!currentPassword || !newEmail) {
    return res.status(400).json({ message: 'currentPassword and newEmail are required' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    return res.status(400).json({ message: 'That doesn\'t look like a valid email address' });
  }

  const { data: authUser } = await supabaseAdmin.auth.admin.getUserById(req.user.id);
  const currentEmail = authUser?.user?.email;
  if (!currentEmail) return res.status(400).json({ message: 'Could not verify your account' });

  const { error: verifyError } = await supabasePublic.auth.signInWithPassword({ email: currentEmail, password: currentPassword });
  if (verifyError) return res.status(401).json({ message: 'Current password is incorrect' });

  const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, { email: newEmail, email_confirm: true });
  if (updateError) return res.status(400).json({ message: updateError.message });

  await logAction({
    businessId: req.user.business_id,
    actor: req.user,
    action: 'email_changed',
    targetId: req.user.id,
    details: { from: currentEmail, to: newEmail, changedBySelf: true },
  });

  res.json({ message: 'Email updated', email: newEmail });
});

module.exports = { register, login, refresh, me, updateMyTheme, updateMyLanguage, updateMyTour, changeMyEmail, confirmDevice, changePassword };

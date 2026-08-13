const asyncHandler = require('../utils/asyncHandler');
const { supabaseAdmin, supabasePublic } = require('../config/supabaseClient');
const { logAction } = require('../utils/auditLog');

// @route GET /api/auth/linked-accounts
// Every account linked to the caller, either direction of the pair.
const listMyLinkedAccounts = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('linked_accounts')
    .select('id, profile_id_a, profile_id_b, created_at, a:profiles!linked_accounts_profile_id_a_fkey(id, name, role, business_id, organization_id, businesses(name)), b:profiles!linked_accounts_profile_id_b_fkey(id, name, role, business_id, organization_id, businesses(name))')
    .or(`profile_id_a.eq.${req.user.id},profile_id_b.eq.${req.user.id}`);
  if (error) return res.status(400).json({ message: error.message });

  // Normalize to "the other profile", regardless of which side of the
  // pair the caller happens to be on - the frontend shouldn't have to
  // know or care about a/b.
  const links = (data || []).map((row) => ({
    linkId: row.id,
    account: row.profile_id_a === req.user.id ? row.b : row.a,
    linkedSince: row.created_at,
  }));
  res.json(links);
});

// @route POST /api/auth/admin/linked-accounts
// Body: { profileIdA, profileIdB }
// super_admin only, deliberately - linking two accounts grants
// password-free sign-in from one into the other, so this has to be
// verified by a real person (support/KYC) confirming the same actual
// business owner controls both, not something either account can
// self-service and silently grant itself access to someone else's data.
const createLinkedAccount = asyncHandler(async (req, res) => {
  const { profileIdA, profileIdB } = req.body;
  if (!profileIdA || !profileIdB || profileIdA === profileIdB) {
    return res.status(400).json({ message: 'Two different profile IDs are required' });
  }
  const { data, error } = await supabaseAdmin
    .from('linked_accounts')
    .insert({ profile_id_a: profileIdA, profile_id_b: profileIdB })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  await logAction({ businessId: null, actor: req.user, action: 'linked_accounts_created', targetId: data.id, details: { profileIdA, profileIdB } });
  res.status(201).json(data);
});

const deleteLinkedAccount = asyncHandler(async (req, res) => {
  const { data: link } = await supabaseAdmin.from('linked_accounts').select('*').eq('id', req.params.linkId).maybeSingle();
  if (!link) return res.status(404).json({ message: 'Link not found' });
  // Either side of the pair can remove the link themselves - it's their
  // own account's convenience feature, no need to escalate to
  // super_admin just to turn it off. super_admin can too, for support.
  const isParty = link.profile_id_a === req.user.id || link.profile_id_b === req.user.id;
  if (!isParty && req.user.role !== 'super_admin') return res.status(403).json({ message: 'Not authorized' });

  await supabaseAdmin.from('linked_accounts').delete().eq('id', req.params.linkId);
  res.json({ message: 'Link removed' });
});

// @route POST /api/auth/switch-account
// Body: { targetProfileId }
// The actual switch: verifies a real link exists between the caller and
// the target, then mints a genuine new session for the target account -
// same generateLink -> verifyOtp mechanism already used for device
// confirmation sign-in elsewhere in this file, not a new auth primitive.
// This grants no NEW access - it only works between accounts already
// explicitly linked by a super_admin, and produces a normal, fully
// independent session exactly as if the person had logged in with that
// account's own credentials.
const switchAccount = asyncHandler(async (req, res) => {
  const { targetProfileId } = req.body;
  if (!targetProfileId) return res.status(400).json({ message: 'targetProfileId is required' });

  const { data: link } = await supabaseAdmin
    .from('linked_accounts')
    .select('id')
    .or(`and(profile_id_a.eq.${req.user.id},profile_id_b.eq.${targetProfileId}),and(profile_id_a.eq.${targetProfileId},profile_id_b.eq.${req.user.id})`)
    .maybeSingle();
  if (!link) return res.status(403).json({ message: 'That account is not linked to yours' });

  const { data: targetProfile } = await supabaseAdmin.from('profiles').select('role, is_active').eq('id', targetProfileId).single();
  if (!targetProfile || !targetProfile.is_active) return res.status(400).json({ message: 'That account is not available to switch into' });

  const { data: targetUser, error: userError } = await supabaseAdmin.auth.admin.getUserById(targetProfileId);
  if (userError || !targetUser?.user?.email) return res.status(400).json({ message: 'Could not look up that account' });

  const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: targetUser.user.email,
  });
  if (linkError) return res.status(500).json({ message: linkError.message });

  const { data: sessionData, error: verifyError } = await supabasePublic.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink',
  });
  if (verifyError) return res.status(500).json({ message: verifyError.message });

  await logAction({ businessId: null, actor: req.user, action: 'account_switched', targetId: targetProfileId });

  res.json({
    accessToken: sessionData.session.access_token,
    refreshToken: sessionData.session.refresh_token,
  });
});

module.exports = { listMyLinkedAccounts, createLinkedAccount, deleteLinkedAccount, switchAccount };

const asyncHandler = require('../utils/asyncHandler');
const { translateToAllLanguages } = require('../utils/translate');
const { getCurrentTier, isThresholdReady } = require('../utils/loyaltyEngine');

// @route GET /api/businesses/:businessId/loyalty/program
const getProgram = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('loyalty_programs')
    .select('*')
    .eq('business_id', req.params.businessId)
    .maybeSingle();

  if (error) return res.status(400).json({ message: error.message });
  res.json(data || null); // null means the business hasn't set one up yet
});

// @route PUT /api/businesses/:businessId/loyalty/program
// Upsert: creates the program on first save, updates it after.
// Body: { earnMethod: 'visit'|'spend', structure: 'threshold'|'tiered',
//         usePoints: bool, rewardType, rewardValue, rewardDescription,
//         enabled, config: {...} }
const upsertProgram = asyncHandler(async (req, res) => {
  const { earnMethod, structure, usePoints, rewardType, rewardValue, rewardDescription, enabled, config } = req.body;

  if (!['visit', 'spend'].includes(earnMethod)) return res.status(400).json({ message: 'Invalid earn method' });
  if (!['threshold', 'tiered'].includes(structure)) return res.status(400).json({ message: 'Invalid structure' });
  if (structure === 'threshold' && rewardType && !['percentage', 'fixed_amount', 'manual'].includes(rewardType)) {
    return res.status(400).json({ message: 'Invalid reward type' });
  }

  const rewardDescriptionI18n = await translateToAllLanguages(rewardDescription).catch(() => ({}));

  const { data, error } = await req.supabase
    .from('loyalty_programs')
    .upsert(
      {
        business_id: req.params.businessId,
        earn_method: earnMethod,
        structure,
        use_points: !!usePoints,
        reward_type: rewardType || 'manual',
        reward_value: rewardValue || 0,
        reward_description: rewardDescription || '',
        reward_description_i18n: rewardDescriptionI18n,
        enabled: !!enabled,
        config: config || {},
      },
      { onConflict: 'business_id' }
    )
    .select()
    .single();

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route GET /api/businesses/:businessId/loyalty/members?search=
const listMembers = asyncHandler(async (req, res) => {
  let query = req.supabase
    .from('loyalty_memberships')
    .select('*, customers(phone, name)')
    .eq('business_id', req.params.businessId)
    .order('updated_at', { ascending: false });

  const { data, error } = await query;
  if (error) return res.status(400).json({ message: error.message });

  const search = (req.query.search || '').trim();
  const filtered = search
    ? data.filter((m) => m.customers?.phone?.includes(search))
    : data;

  res.json(filtered);
});

// @route POST /api/businesses/:businessId/loyalty/members/:membershipId/adjust
// Manual add/remove — e.g. correcting a mistake or a goodwill stamp.
// Body: { visits?, points?, spendAmount?, note? }
const adjustMember = asyncHandler(async (req, res) => {
  const { visits = 0, points = 0, spendAmount = 0, note = '' } = req.body;

  const { data: membership, error: fetchError } = await req.supabase
    .from('loyalty_memberships')
    .select('*')
    .eq('id', req.params.membershipId)
    .eq('business_id', req.params.businessId)
    .single();
  if (fetchError || !membership) return res.status(404).json({ message: 'Member not found' });

  const update = {
    visits: membership.visits + Number(visits),
    points: membership.points + Number(points),
    total_spend: Number(membership.total_spend) + Number(spendAmount),
  };

  // Spend and points are never earned via a tap - this manual adjustment
  // is the ONLY moment a spend-tiered (or points-tiered) member's status
  // can actually change, so the tier has to be recomputed right here.
  const { data: program } = await req.supabase.from('loyalty_programs').select('*').eq('business_id', req.params.businessId).maybeSingle();
  if (program && program.structure === 'tiered') {
    const tier = getCurrentTier(program, { ...membership, ...update });
    update.current_tier = tier ? tier.name : membership.current_tier;
  }

  const { data: updated, error: updateError } = await req.supabase
    .from('loyalty_memberships')
    .update(update)
    .eq('id', membership.id)
    .select()
    .single();
  if (updateError) return res.status(400).json({ message: updateError.message });

  await req.supabase.from('loyalty_transactions').insert({
    business_id: req.params.businessId,
    membership_id: membership.id,
    type: 'manual_adjust',
    amount: visits || points || spendAmount || 0,
    note,
    created_by: req.user.id,
  });

  res.json(updated);
});

// @route POST /api/businesses/:businessId/loyalty/members/:membershipId/redeem
// Staff redeeming a threshold reward directly from the dashboard - for
// when a customer isn't looking at their phone, or staff want to comp
// something proactively. Immediate, not a claim (staff ARE the one
// acting, there's no async gap for anyone else to see and act on).
const redeemReward = asyncHandler(async (req, res) => {
  const { data: program } = await req.supabase
    .from('loyalty_programs')
    .select('*')
    .eq('business_id', req.params.businessId)
    .single();
  if (!program) return res.status(404).json({ message: 'No loyalty program configured' });
  if (program.structure !== 'threshold') {
    return res.status(400).json({ message: 'Tiered rewards apply automatically at payment - there is nothing to redeem here' });
  }

  const { data: membership, error: fetchError } = await req.supabase
    .from('loyalty_memberships')
    .select('*')
    .eq('id', req.params.membershipId)
    .eq('business_id', req.params.businessId)
    .single();
  if (fetchError || !membership) return res.status(404).json({ message: 'Member not found' });

  if (!isThresholdReady(program, membership)) {
    return res.status(400).json({ message: 'This member has not reached the reward threshold yet' });
  }

  const resetUpdate = program.earn_method === 'spend' ? { total_spend: 0 } : program.use_points ? { points: 0 } : { visits: 0 };

  const { data: updated, error: updateError } = await req.supabase
    .from('loyalty_memberships')
    .update(resetUpdate)
    .eq('id', membership.id)
    .select()
    .single();
  if (updateError) return res.status(400).json({ message: updateError.message });

  await req.supabase.from('loyalty_transactions').insert({
    business_id: req.params.businessId,
    membership_id: membership.id,
    type: 'redeem',
    amount: 0,
    note: program.reward_description || '',
    created_by: req.user.id,
  });

  res.json(updated);
});

// @route GET /api/businesses/:businessId/loyalty/claims
// Pending reward claims - shown in the same Requests panel as Call
// Waiter/Request Bill.
const listClaims = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('loyalty_reward_claims')
    .select('*, loyalty_memberships(customers(phone))')
    .eq('business_id', req.params.businessId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route PATCH /api/businesses/:businessId/loyalty/claims/:claimId/apply
// For 'manual' rewards only (free item, etc.) - there's no number to
// auto-subtract at payment, so staff mark it done themselves once
// they've actually handed over whatever it was. Resets the membership,
// same as any other redemption.
const applyManualClaim = asyncHandler(async (req, res) => {
  const { data: claim, error: fetchError } = await req.supabase
    .from('loyalty_reward_claims')
    .select('*')
    .eq('id', req.params.claimId)
    .eq('business_id', req.params.businessId)
    .eq('status', 'pending')
    .single();
  if (fetchError || !claim) return res.status(404).json({ message: 'Claim not found or already resolved' });

  const { data: membership } = await req.supabase.from('loyalty_memberships').select('*').eq('id', claim.membership_id).single();
  const { data: program } = await req.supabase.from('loyalty_programs').select('*').eq('business_id', req.params.businessId).single();

  if (membership && program) {
    const resetUpdate = program.earn_method === 'spend' ? { total_spend: 0 } : program.use_points ? { points: 0 } : { visits: 0 };
    await req.supabase.from('loyalty_memberships').update(resetUpdate).eq('id', membership.id);
    await req.supabase.from('loyalty_transactions').insert({
      business_id: req.params.businessId,
      membership_id: membership.id,
      type: 'redeem',
      amount: 0,
      note: claim.reward_description,
      created_by: req.user.id,
    });
  }

  const { data: updated, error: updateError } = await req.supabase
    .from('loyalty_reward_claims')
    .update({ status: 'applied', applied_at: new Date().toISOString() })
    .eq('id', claim.id)
    .select()
    .single();
  if (updateError) return res.status(400).json({ message: updateError.message });
  res.json(updated);
});

module.exports = { getProgram, upsertProgram, listMembers, adjustMember, redeemReward, listClaims, applyManualClaim };

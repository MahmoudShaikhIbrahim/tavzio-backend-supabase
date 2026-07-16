const asyncHandler = require('../utils/asyncHandler');

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
// Body: { type: 'punch_card'|'points'|'tiered'|'spend', enabled: bool, config: {...} }
const upsertProgram = asyncHandler(async (req, res) => {
  const { type, enabled, config } = req.body;
  if (!['punch_card', 'points', 'tiered', 'spend'].includes(type)) {
    return res.status(400).json({ message: 'Invalid loyalty type' });
  }

  const { data, error } = await req.supabase
    .from('loyalty_programs')
    .upsert(
      { business_id: req.params.businessId, type, enabled: !!enabled, config: config || {} },
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
// Marks a reward as redeemed and deducts the cost (points/visits reset by
// the program's threshold — keeps any surplus rather than zeroing it out).
const redeemReward = asyncHandler(async (req, res) => {
  const { data: program } = await req.supabase
    .from('loyalty_programs')
    .select('*')
    .eq('business_id', req.params.businessId)
    .single();
  if (!program) return res.status(404).json({ message: 'No loyalty program configured' });

  const { data: membership, error: fetchError } = await req.supabase
    .from('loyalty_memberships')
    .select('*')
    .eq('id', req.params.membershipId)
    .eq('business_id', req.params.businessId)
    .single();
  if (fetchError || !membership) return res.status(404).json({ message: 'Member not found' });

  const update = {};
  if (program.type === 'punch_card') {
    const required = program.config?.visitsRequired || 10;
    if (membership.visits < required) return res.status(400).json({ message: 'Not enough visits yet' });
    update.visits = membership.visits - required;
  } else if (program.type === 'points') {
    const threshold = program.config?.redeemThreshold || 100;
    if (membership.points < threshold) return res.status(400).json({ message: 'Not enough points yet' });
    update.points = membership.points - threshold;
  } else {
    return res.status(400).json({ message: 'This program type has no one-time redemption' });
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
    type: 'redeem',
    amount: 0,
    note: program.config?.reward || '',
    created_by: req.user.id,
  });

  res.json(updated);
});

module.exports = { getProgram, upsertProgram, listMembers, adjustMember, redeemReward };

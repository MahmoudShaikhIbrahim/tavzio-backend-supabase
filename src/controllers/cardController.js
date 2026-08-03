const asyncHandler = require('../utils/asyncHandler');
const { revokeSessionsFor } = require('../utils/revokeSessions');

// @route POST /api/businesses/:businessId/cards
const createCards = asyncHandler(async (req, res) => {
  const { businessId } = req.params;
  const { count = 1, label = '' } = req.body;

  const docs = Array.from({ length: Math.max(1, Number(count)) }, () => ({
    business_id: businessId,
    label,
  }));

  const { data, error } = await req.supabase.from('cards').insert(docs).select();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// @route GET /api/businesses/:businessId/cards
const listCards = asyncHandler(async (req, res) => {
  let query = req.supabase
    .from('cards')
    .select('*')
    .eq('business_id', req.params.businessId)
    .order('created_at', { ascending: false });

  if (req.query.status) query = query.eq('status', req.query.status);

  const { data, error } = await query;
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route PATCH /api/businesses/:businessId/cards/:cardId
const updateCard = asyncHandler(async (req, res) => {
  const { label, status } = req.body;
  const update = {};
  if (label !== undefined) update.label = label;
  if (status !== undefined) {
    update.status = status;
    update.last_programmed_at = new Date().toISOString();
  }

  const { data, error } = await req.supabase
    .from('cards')
    .update(update)
    .eq('id', req.params.cardId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ message: 'Card not found' });
  res.json(data);
});

// @route DELETE /api/businesses/:businessId/cards/:cardId
// @route DELETE /api/businesses/:businessId/cards/:cardId
// super_admin only, restored deliberately - owner/staff still have no
// delete capability at all, "Disable" remains their only path. RLS backs
// this up independently (see migration 0010).
const deleteCard = asyncHandler(async (req, res) => {
  const { data: card } = await req.supabase.from('cards').select('label, uid').eq('id', req.params.cardId).maybeSingle();

  const { error, count } = await req.supabase
    .from('cards')
    .delete({ count: 'exact' })
    .eq('id', req.params.cardId)
    .eq('business_id', req.params.businessId);

  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Card not found' });

  res.json({ message: 'Card deleted' });
});

// @route POST /api/businesses/:businessId/staff/:userId/card
// Issues a fresh admin tap card linked to a specific person (owner or
// staff). One request now covers "first card for a new person" and
// "reissue after losing it" atomically via a single Postgres function —
// no window where disable-old and create-new are two separate steps.
const issueAdminCard = asyncHandler(async (req, res) => {
  const { businessId, userId } = req.params;

  const { data: newCard, error } = await req.supabase.rpc('reissue_admin_card', {
    p_business_id: businessId,
    p_user_id: userId,
    p_label: req.body.label || 'Admin card',
  });
  if (error) return res.status(400).json({ message: error.message });

  // Closes the gap where a session issued from the OLD card would
  // otherwise stay valid until it naturally expires.
  await revokeSessionsFor(userId);

  res.status(201).json(newCard);
});

module.exports = { createCards, listCards, updateCard, deleteCard, issueAdminCard };

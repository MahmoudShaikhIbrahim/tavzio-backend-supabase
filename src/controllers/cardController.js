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
  const { label, status, roomId } = req.body;
  const update = {};
  if (label !== undefined) update.label = label;
  if (status !== undefined) {
    update.status = status;
    update.last_programmed_at = new Date().toISOString();
  }
  // Links (or, with null, unlinks) this physical stand to a hotel room -
  // this is what makes a tap on that stand route to the guest portal for
  // that specific room instead of the normal landing page (see
  // resolveCardTap). roomId === undefined means "not part of this
  // update" (leave as-is); roomId === null is an explicit unlink.
  if (roomId !== undefined) update.room_id = roomId;

  const { data, error } = await req.supabase
    .from('cards')
    .update(update)
    .eq('id', req.params.cardId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ message: 'Card not found' });

  // Confirmed decision: labeling a card the same as an existing room
  // (e.g. naming this stand "Room 1") connects them automatically, same
  // instinct as a restaurant card labeled "Table 1" - no separate
  // manual step required when the label already says which room this
  // is. Only when this update actually touched the label, only an
  // exact match, and only if the card doesn't already have a different
  // room explicitly linked (roomId wasn't itself part of this same
  // request, and it isn't already linked to something else) - this
  // must never silently override a deliberate, different link.
  if (label !== undefined && roomId === undefined && !data.room_id) {
    const { data: matchingRoom } = await req.supabase
      .from('hotel_rooms')
      .select('id')
      .eq('business_id', req.params.businessId)
      .ilike('room_number', label)
      .maybeSingle();
    if (matchingRoom) {
      // Never silently give a room a second stand - if one's already
      // linked, this is almost certainly a naming coincidence or a
      // mistake, not an intentional second connection, and should be
      // handled explicitly rather than auto-linked.
      const { data: alreadyLinkedCard } = await req.supabase
        .from('cards')
        .select('id')
        .eq('room_id', matchingRoom.id)
        .maybeSingle();
      if (!alreadyLinkedCard) {
        const { data: relinked } = await req.supabase
          .from('cards')
          .update({ room_id: matchingRoom.id })
          .eq('id', data.id)
          .select()
          .single();
        if (relinked) return res.json(relinked);
      }
    }
  }

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

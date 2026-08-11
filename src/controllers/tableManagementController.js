const asyncHandler = require('../utils/asyncHandler');

// @route GET /api/businesses/:businessId/tables-floor
// Every active card (table) with its floor status, seat count, and
// whatever's currently unpaid/active on it - the actual floor plan view.
// Named "tables-floor" rather than reusing /cards, since /cards already
// means something else (card lifecycle management, not floor status).
const listFloorTables = asyncHandler(async (req, res) => {
  const { data: cards, error } = await req.supabase
    .from('cards')
    .select('*')
    .eq('business_id', req.params.businessId)
    .eq('status', 'active')
    .order('label');
  if (error) return res.status(400).json({ message: error.message });

  const { data: orders } = await req.supabase
    .from('orders')
    .select('id, card_id, total, status')
    .eq('business_id', req.params.businessId)
    .eq('request_type', 'order')
    .eq('voided', false)
    .neq('status', 'awaiting_payment')
    .neq('status', 'cancelled')
    .neq('status', 'completed');

  const ordersByCard = new Map();
  for (const o of orders || []) {
    if (!o.card_id) continue;
    const list = ordersByCard.get(o.card_id) || [];
    list.push(o);
    ordersByCard.set(o.card_id, list);
  }

  const tables = (cards || []).map((c) => ({
    ...c,
    activeOrders: ordersByCard.get(c.id) || [],
  }));
  res.json(tables);
});

// @route PATCH /api/businesses/:businessId/tables-floor/:cardId
// Body: { tableStatus?, seatCount? }
const updateTableStatus = asyncHandler(async (req, res) => {
  const { tableStatus, seatCount } = req.body;
  const update = {};
  if (tableStatus !== undefined) update.table_status = tableStatus;
  if (seatCount !== undefined) update.seat_count = seatCount;

  const { data, error } = await req.supabase
    .from('cards')
    .update(update)
    .eq('id', req.params.cardId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/tables-floor/:cardId/merge
// Body: { mergeWithCardId }
// Marks `cardId` as merged into `mergeWithCardId` - a bigger party
// spanning two physical tables now reads as one group on the floor plan.
const mergeTables = asyncHandler(async (req, res) => {
  const { mergeWithCardId } = req.body;
  if (!mergeWithCardId) return res.status(400).json({ message: 'mergeWithCardId is required' });

  const { data, error } = await req.supabase
    .from('cards')
    .update({ merged_with_card_id: mergeWithCardId, table_status: 'occupied' })
    .eq('id', req.params.cardId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/tables-floor/:cardId/unmerge
const unmergeTable = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('cards')
    .update({ merged_with_card_id: null })
    .eq('id', req.params.cardId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// --- Waitlist ---

// @route GET /api/businesses/:businessId/waitlist
const listWaitlist = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('waitlist_entries')
    .select('*')
    .eq('business_id', req.params.businessId)
    .neq('status', 'cancelled')
    .order('created_at');
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/waitlist
const addToWaitlist = asyncHandler(async (req, res) => {
  const { guestName, partySize = 1, phone = '' } = req.body;
  if (!guestName) return res.status(400).json({ message: 'guestName is required' });

  const { data, error } = await req.supabase
    .from('waitlist_entries')
    .insert({ business_id: req.params.businessId, guest_name: guestName, party_size: partySize, phone })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// @route POST /api/businesses/:businessId/waitlist/:entryId/seat
// Body: { cardId } - the table this party is being seated at. Marks the
// table occupied in the same motion, so hosts never seat a party and
// forget to update the floor plan as two separate steps.
const seatWaitlistEntry = asyncHandler(async (req, res) => {
  const { cardId } = req.body;
  if (!cardId) return res.status(400).json({ message: 'cardId is required' });

  await req.supabase.from('cards').update({ table_status: 'occupied' }).eq('id', cardId).eq('business_id', req.params.businessId);

  const { data, error } = await req.supabase
    .from('waitlist_entries')
    .update({ status: 'seated', seated_card_id: cardId, seated_at: new Date().toISOString() })
    .eq('id', req.params.entryId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/waitlist/:entryId/cancel
const cancelWaitlistEntry = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('waitlist_entries')
    .update({ status: 'cancelled' })
    .eq('id', req.params.entryId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

module.exports = {
  listFloorTables, updateTableStatus, mergeTables, unmergeTable,
  listWaitlist, addToWaitlist, seatWaitlistEntry, cancelWaitlistEntry,
};

const asyncHandler = require('../utils/asyncHandler');

// @route GET /api/businesses/:businessId/tables
// The real floor plan view - every table, whether or not it currently
// has a card connected, with its connected card (if any) and whatever
// orders are active on it right now.
const listTables = asyncHandler(async (req, res) => {
  const { data: tables, error } = await req.supabase
    .from('tables')
    .select('*, cards(id, uid, label, status)')
    .eq('business_id', req.params.businessId)
    .order('label');
  if (error) return res.status(400).json({ message: error.message });

  const connectedCardIds = tables.map((t) => t.cards?.[0]?.id).filter(Boolean);
  const { data: orders } = connectedCardIds.length > 0 ? await req.supabase
    .from('orders')
    .select('id, card_id, total, status')
    .eq('business_id', req.params.businessId)
    .eq('request_type', 'order')
    .eq('voided', false)
    .neq('status', 'awaiting_payment')
    .neq('status', 'cancelled')
    .neq('status', 'completed')
    .in('card_id', connectedCardIds) : { data: [] };

  const ordersByCard = new Map();
  for (const o of orders || []) {
    const list = ordersByCard.get(o.card_id) || [];
    list.push(o);
    ordersByCard.set(o.card_id, list);
  }

  const result = tables.map((t) => {
    const card = t.cards?.[0] || null;
    return {
      id: t.id,
      label: t.label,
      seatCount: t.seat_count,
      status: t.status,
      mergedWithTableId: t.merged_with_table_id,
      // Real, explicit addition for the floor plan feature: gridX/gridY
      // are null until a business actually arranges their map - the
      // frontend falls back to the existing card-grid view for any
      // table that hasn't been placed yet, nothing breaks for a
      // business that never touches this.
      gridX: t.grid_x,
      gridY: t.grid_y,
      shape: t.shape,
      zone: t.zone,
      card: card ? { id: card.id, uid: card.uid, status: card.status } : null,
      activeOrders: card ? (ordersByCard.get(card.id) || []) : [],
    };
  });
  res.json(result);
});

// @route POST /api/businesses/:businessId/tables
const createTable = asyncHandler(async (req, res) => {
  const { label, seatCount = 2 } = req.body;
  if (!label?.trim()) return res.status(400).json({ message: 'A table name/number is required' });

  const { data, error } = await req.supabase
    .from('tables')
    .insert({ business_id: req.params.businessId, label: label.trim(), seat_count: seatCount })
    .select()
    .single();
  if (error) {
    if (error.code === '23505') return res.status(400).json({ message: `A table named "${label.trim()}" already exists` });
    return res.status(400).json({ message: error.message });
  }
  res.status(201).json(data);
});

// @route PATCH /api/businesses/:businessId/tables/:tableId
// Body: { label?, seatCount?, status?, gridX?, gridY?, shape?, zone? }
const updateTable = asyncHandler(async (req, res) => {
  const { label, seatCount, status, gridX, gridY, shape, zone } = req.body;
  const update = { updated_at: new Date().toISOString() };
  if (label !== undefined) update.label = label.trim();
  if (seatCount !== undefined) update.seat_count = seatCount;
  if (status !== undefined) update.status = status;
  // Real, explicit addition: placing a table on the floor plan grid.
  // gridX/gridY are sent together and can be explicitly null (a
  // business un-placing a table, moving it back to "not yet arranged"),
  // so these check for `!== undefined`, not truthiness.
  if (gridX !== undefined) update.grid_x = gridX;
  if (gridY !== undefined) update.grid_y = gridY;
  if (shape !== undefined) update.shape = shape;
  if (zone !== undefined) update.zone = zone.trim();

  const { data, error } = await req.supabase
    .from('tables')
    .update(update)
    .eq('id', req.params.tableId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ message: 'Table not found' });
  res.json(data);
});

// @route DELETE /api/businesses/:businessId/tables/:tableId
// Real, deliberate guard: refuses to delete a table with a currently
// active, unpaid order on it - deleting it would silently orphan real
// money owed. Its connected card (if any) is unlinked automatically via
// the foreign key's own "on delete set null" - the card itself isn't
// touched, it's just free to be connected to a different table.
const deleteTable = asyncHandler(async (req, res) => {
  const { data: table } = await req.supabase.from('tables').select('id').eq('id', req.params.tableId).eq('business_id', req.params.businessId).maybeSingle();
  if (!table) return res.status(404).json({ message: 'Table not found' });

  const { data: card } = await req.supabase.from('cards').select('id').eq('table_id', table.id).maybeSingle();
  if (card) {
    const { data: activeOrders } = await req.supabase
      .from('orders')
      .select('id')
      .eq('card_id', card.id)
      .eq('voided', false)
      .neq('status', 'completed')
      .neq('status', 'cancelled')
      .limit(1);
    if (activeOrders && activeOrders.length > 0) {
      return res.status(400).json({ message: 'This table has an active order - settle or clear it before deleting the table' });
    }
  }

  await req.supabase.from('tables').delete().eq('id', req.params.tableId).eq('business_id', req.params.businessId);
  res.json({ message: 'Table deleted' });
});

// @route POST /api/businesses/:businessId/tables/:tableId/connect-card
// Body: { cardId }
// The actual "wire an NFC stand to a table" action. Disconnects the card
// from any OTHER table it was previously on first - a card only ever
// represents one physical table at a time, never two simultaneously.
const connectCard = asyncHandler(async (req, res) => {
  const { cardId } = req.body;
  if (!cardId) return res.status(400).json({ message: 'cardId is required' });

  const { data: card } = await req.supabase
    .from('cards')
    .select('id, linked_user_id, status, room_id')
    .eq('id', cardId)
    .eq('business_id', req.params.businessId)
    .maybeSingle();
  if (!card) return res.status(404).json({ message: 'Card not found for this business' });
  if (card.linked_user_id) return res.status(400).json({ message: 'That card is a staff login card, not a table stand' });
  if (card.room_id) return res.status(400).json({ message: 'That card is already connected to a hotel room' });
  if (card.status !== 'active') return res.status(400).json({ message: 'That card is not active' });

  const { data: table } = await req.supabase.from('tables').select('id, label, merged_with_table_id').eq('id', req.params.tableId).eq('business_id', req.params.businessId).maybeSingle();
  if (!table) return res.status(404).json({ message: 'Table not found' });

  const update = { table_id: table.id, label: table.label };
  // Real sync: if this table is already merged into another one, the
  // newly-connected card needs to inherit that merge immediately, not
  // leave the table showing merged while the actual NFC session isn't.
  if (table.merged_with_table_id) {
    const { data: targetCard } = await req.supabase.from('cards').select('id').eq('table_id', table.merged_with_table_id).maybeSingle();
    if (targetCard) update.merged_with_card_id = targetCard.id;
  }
  await req.supabase.from('cards').update(update).eq('id', cardId);
  res.json({ message: `Card connected to ${table.label}` });
});

// @route POST /api/businesses/:businessId/tables/:tableId/disconnect-card
// Real fix for the actual point of this whole redesign: a lost or
// damaged NFC stand no longer means losing the table - this just frees
// the table to have a different (or replacement) card connected next,
// with the table's own identity, status, and history untouched.
const disconnectCard = asyncHandler(async (req, res) => {
  const { error } = await req.supabase
    .from('cards')
    .update({ table_id: null, merged_with_card_id: null })
    .eq('table_id', req.params.tableId)
    .eq('business_id', req.params.businessId);
  if (error) return res.status(400).json({ message: error.message });
  res.json({ message: 'Card disconnected - the table is unchanged and ready for a new card' });
});

// @route POST /api/businesses/:businessId/tables/:tableId/merge
// Body: { mergeWithTableId }
const mergeTables = asyncHandler(async (req, res) => {
  const { mergeWithTableId } = req.body;
  if (!mergeWithTableId) return res.status(400).json({ message: 'mergeWithTableId is required' });

  const { data, error } = await req.supabase
    .from('tables')
    .update({ merged_with_table_id: mergeWithTableId, status: 'occupied' })
    .eq('id', req.params.tableId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  // Real sync, not just a floor-plan label - a merge only actually
  // combines the two tables' NFC sessions (so a tap on either stand
  // resolves to the same effective card, see publicController.js) if
  // both currently have a card connected. If either doesn't yet, the
  // table-level merge above still succeeds on its own - a real, valid
  // state - it just has no card-level effect to apply until one is.
  const [{ data: fromCard }, { data: toCard }] = await Promise.all([
    req.supabase.from('cards').select('id').eq('table_id', req.params.tableId).maybeSingle(),
    req.supabase.from('cards').select('id').eq('table_id', mergeWithTableId).maybeSingle(),
  ]);
  if (fromCard && toCard) {
    await req.supabase.from('cards').update({ merged_with_card_id: toCard.id }).eq('id', fromCard.id);
  }

  res.json(data);
});

// @route POST /api/businesses/:businessId/tables/:tableId/unmerge
const unmergeTable = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('tables')
    .update({ merged_with_table_id: null })
    .eq('id', req.params.tableId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  // Same real sync in reverse - clears the card-level merge too, so an
  // unmerged table's stand genuinely goes back to operating as its own
  // independent session, not just looking unmerged on the floor plan.
  const { data: card } = await req.supabase.from('cards').select('id').eq('table_id', req.params.tableId).maybeSingle();
  if (card) {
    await req.supabase.from('cards').update({ merged_with_card_id: null }).eq('id', card.id);
  }

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
// Body: { tableId } - the table this party is being seated at. Marks the
// table occupied in the same motion, so hosts never seat a party and
// forget to update the floor plan as two separate steps.
const seatWaitlistEntry = asyncHandler(async (req, res) => {
  const { tableId } = req.body;
  if (!tableId) return res.status(400).json({ message: 'tableId is required' });

  await req.supabase.from('tables').update({ status: 'occupied' }).eq('id', tableId).eq('business_id', req.params.businessId);
  const { data: card } = await req.supabase.from('cards').select('id').eq('table_id', tableId).maybeSingle();

  const { data, error } = await req.supabase
    .from('waitlist_entries')
    .update({ status: 'seated', seated_card_id: card?.id || null, seated_at: new Date().toISOString() })
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

// @route GET /api/businesses/:businessId/floor-plan-cells
// The architectural elements (walls/windows/door/counter/plant) placed
// on the same grid tables are - real placed elements, not decoration
// baked into the frontend, so every business's map genuinely reflects
// their own room.
const listFloorPlanCells = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('floor_plan_cells')
    .select('id, grid_x, grid_y, cell_type')
    .eq('business_id', req.params.businessId);
  if (error) return res.status(400).json({ message: error.message });
  res.json(data.map((c) => ({ id: c.id, gridX: c.grid_x, gridY: c.grid_y, cellType: c.cell_type })));
});

// @route PUT /api/businesses/:businessId/floor-plan-cells
// Body: { cells: [{ gridX, gridY, cellType }] }
// Replaces the WHOLE set in one call, same tap-to-place editing session
// pattern as arranging tables - staff build up the outline over several
// taps, then save once, rather than one request per wall segment.
const setFloorPlanCells = asyncHandler(async (req, res) => {
  const { cells } = req.body;
  if (!Array.isArray(cells)) return res.status(400).json({ message: 'cells must be an array' });

  const { error: deleteError } = await req.supabase
    .from('floor_plan_cells')
    .delete()
    .eq('business_id', req.params.businessId);
  if (deleteError) return res.status(400).json({ message: deleteError.message });

  if (cells.length === 0) return res.json([]);

  const rows = cells.map((c) => ({
    business_id: req.params.businessId,
    grid_x: c.gridX,
    grid_y: c.gridY,
    cell_type: c.cellType,
  }));
  const { data, error } = await req.supabase.from('floor_plan_cells').insert(rows).select();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data.map((c) => ({ id: c.id, gridX: c.grid_x, gridY: c.grid_y, cellType: c.cell_type })));
});

module.exports = {
  listTables, createTable, updateTable, deleteTable, connectCard, disconnectCard, mergeTables, unmergeTable,
  listWaitlist, addToWaitlist, seatWaitlistEntry, cancelWaitlistEntry,
  listFloorPlanCells, setFloorPlanCells,
};

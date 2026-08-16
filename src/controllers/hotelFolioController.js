const asyncHandler = require('../utils/asyncHandler');
const { logAction } = require('../utils/auditLog');

const getFolio = asyncHandler(async (req, res) => {
  const { data: folio } = await req.supabase
    .from('hotel_folios')
    .select('*, hotel_reservations(check_in_date, check_out_date, hotel_guests(name, phone, email), hotel_rooms(room_number))')
    .eq('id', req.params.folioId)
    .eq('business_id', req.params.businessId)
    .single();
  if (!folio) return res.status(404).json({ message: 'Folio not found' });

  const { data: charges } = await req.supabase
    .from('hotel_folio_charges')
    .select('*')
    .eq('folio_id', folio.id)
    .order('created_at');

  const balance = (charges || []).reduce((sum, c) => sum + Number(c.amount_aed), 0);
  res.json({ ...folio, charges: charges || [], balance });
});

// @route GET /api/businesses/:businessId/hotel/folios/by-reservation/:reservationId
// Now returns EVERY folio on the reservation (a split reservation has
// more than one) rather than assuming exactly one exists.
const getFoliosByReservation = asyncHandler(async (req, res) => {
  const { data: folios } = await req.supabase
    .from('hotel_folios')
    .select('*')
    .eq('reservation_id', req.params.reservationId)
    .eq('business_id', req.params.businessId)
    .order('is_primary', { ascending: false });
  if (!folios || folios.length === 0) return res.status(404).json({ message: 'No folio for this reservation' });

  const results = [];
  for (const folio of folios) {
    const { data: charges } = await req.supabase.from('hotel_folio_charges').select('*').eq('folio_id', folio.id).order('created_at');
    const balance = (charges || []).reduce((sum, c) => sum + Number(c.amount_aed), 0);
    results.push({ ...folio, charges: charges || [], balance });
  }
  res.json(results);
});

const addCharge = asyncHandler(async (req, res) => {
  const { description, amountAed, chargeType = 'other' } = req.body;
  if (!description || amountAed == null) return res.status(400).json({ message: 'description and amountAed are required' });

  const { data: folio } = await req.supabase.from('hotel_folios').select('status').eq('id', req.params.folioId).eq('business_id', req.params.businessId).single();
  if (!folio) return res.status(404).json({ message: 'Folio not found' });
  if (folio.status === 'closed') return res.status(400).json({ message: 'This folio is closed' });

  const { data, error } = await req.supabase
    .from('hotel_folio_charges')
    .insert({ folio_id: req.params.folioId, description, amount_aed: amountAed, charge_type: chargeType })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  await logAction({ businessId: req.params.businessId, actor: req.user, action: 'folio_charge_added', targetId: data.id, details: { folioId: req.params.folioId, description, amountAed, chargeType } });
  res.status(201).json(data);
});

// The actual "undo" a manually-added charge needed - a payment,
// deposit, or refund is real money that already moved and stays a
// permanent record, but a charge that was added by mistake (wrong
// amount, wrong room, changed their mind) should be reversible while
// the folio is still open, not a permanent commitment the moment it's
// typed in.
const deleteCharge = asyncHandler(async (req, res) => {
  const { data: folio } = await req.supabase.from('hotel_folios').select('status').eq('id', req.params.folioId).eq('business_id', req.params.businessId).single();
  if (!folio) return res.status(404).json({ message: 'Folio not found' });
  if (folio.status === 'closed') return res.status(400).json({ message: 'This folio is closed' });

  const { data: charge } = await req.supabase.from('hotel_folio_charges').select('*').eq('id', req.params.chargeId).eq('folio_id', req.params.folioId).maybeSingle();
  if (!charge) return res.status(404).json({ message: 'Charge not found' });

  const { error } = await req.supabase.from('hotel_folio_charges').delete().eq('id', req.params.chargeId);
  if (error) return res.status(400).json({ message: error.message });

  await logAction({ businessId: req.params.businessId, actor: req.user, action: 'folio_charge_deleted', targetId: req.params.chargeId, details: { folioId: req.params.folioId, description: charge.description, amountAed: charge.amount_aed } });
  res.json({ message: 'Charge deleted' });
});

const recordPayment = asyncHandler(async (req, res) => {
  const { amountAed, description = 'Payment' } = req.body;
  if (!amountAed || amountAed <= 0) return res.status(400).json({ message: 'amountAed must be a positive number' });

  const { data: folio } = await req.supabase.from('hotel_folios').select('status').eq('id', req.params.folioId).eq('business_id', req.params.businessId).single();
  if (!folio) return res.status(404).json({ message: 'Folio not found' });

  const { data, error } = await req.supabase
    .from('hotel_folio_charges')
    .insert({ folio_id: req.params.folioId, description, amount_aed: -Math.abs(amountAed), charge_type: 'payment' })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  await logAction({ businessId: req.params.businessId, actor: req.user, action: 'folio_payment_recorded', targetId: data.id, details: { folioId: req.params.folioId, amountAed, description } });
  res.status(201).json(data);
});

// @route POST /api/businesses/:businessId/hotel/folios/:folioId/deposit
const recordDeposit = asyncHandler(async (req, res) => {
  const { amountAed, description = 'Deposit' } = req.body;
  if (!amountAed || amountAed <= 0) return res.status(400).json({ message: 'amountAed must be a positive number' });

  const { data, error } = await req.supabase
    .from('hotel_folio_charges')
    .insert({ folio_id: req.params.folioId, description, amount_aed: -Math.abs(amountAed), charge_type: 'deposit' })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  await logAction({ businessId: req.params.businessId, actor: req.user, action: 'folio_payment_recorded', targetId: data.id, details: { folioId: req.params.folioId, amountAed, description, type: 'deposit' } });
  res.status(201).json(data);
});

// @route POST /api/businesses/:businessId/hotel/folios/:folioId/refund
// A refund increases the folio balance (money going back to the guest
// means less net has been collected) - the opposite sign of a payment,
// on purpose, so the running total stays a single honest ledger.
const recordRefund = asyncHandler(async (req, res) => {
  const { amountAed, description = 'Refund', reason } = req.body;
  if (!amountAed || amountAed <= 0) return res.status(400).json({ message: 'amountAed must be a positive number' });
  if (!reason) return res.status(400).json({ message: 'A reason is required for every refund' });

  const { data, error } = await req.supabase
    .from('hotel_folio_charges')
    .insert({ folio_id: req.params.folioId, description: `${description} - ${reason}`, amount_aed: Math.abs(amountAed), charge_type: 'refund' })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  await logAction({ businessId: req.params.businessId, actor: req.user, action: 'folio_refund_issued', targetId: data.id, details: { folioId: req.params.folioId, amountAed, reason } });
  res.status(201).json(data);
});

// @route POST /api/businesses/:businessId/hotel/folios/:folioId/adjustment
// Body: { amountAed, description } - amountAed can be positive or
// negative, since an adjustment is a genuine correction, not a
// one-directional operation like a payment or a charge.
const recordAdjustment = asyncHandler(async (req, res) => {
  const { amountAed, description, reason } = req.body;
  if (amountAed == null || !description) return res.status(400).json({ message: 'amountAed and description are required' });
  if (!reason) return res.status(400).json({ message: 'A reason is required for every adjustment' });

  const { data, error } = await req.supabase
    .from('hotel_folio_charges')
    .insert({ folio_id: req.params.folioId, description: `${description} - ${reason}`, amount_aed: amountAed, charge_type: 'adjustment' })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  await logAction({ businessId: req.params.businessId, actor: req.user, action: 'folio_adjustment_made', targetId: data.id, details: { folioId: req.params.folioId, amountAed, description, reason } });
  res.status(201).json(data);
});

// @route POST /api/businesses/:businessId/hotel/folios/:folioId/split
// Body: { chargeIds: [...], payerType?, companyName? }
// Moves the given charges onto a brand new folio on the same
// reservation - e.g. separating what the company is paying for from
// what the guest is paying personally.
const splitFolio = asyncHandler(async (req, res) => {
  const { chargeIds, payerType = 'guest', companyName = '' } = req.body;
  if (!Array.isArray(chargeIds) || chargeIds.length === 0) return res.status(400).json({ message: 'chargeIds is required' });

  const { data: sourceFolio } = await req.supabase.from('hotel_folios').select('*').eq('id', req.params.folioId).eq('business_id', req.params.businessId).single();
  if (!sourceFolio) return res.status(404).json({ message: 'Folio not found' });

  const { data: newFolio, error } = await req.supabase
    .from('hotel_folios')
    .insert({ business_id: req.params.businessId, reservation_id: sourceFolio.reservation_id, is_primary: false, payer_type: payerType, company_name: companyName })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  await req.supabase.from('hotel_folio_charges').update({ folio_id: newFolio.id }).in('id', chargeIds).eq('folio_id', req.params.folioId);

  await logAction({ businessId: req.params.businessId, actor: req.user, action: 'folio_split', targetId: newFolio.id, details: { fromFolioId: req.params.folioId, chargeIds, payerType } });
  res.status(201).json(newFolio);
});

// @route POST /api/businesses/:businessId/hotel/folios/:folioId/transfer-charge
// Body: { chargeId, toFolioId }
const transferCharge = asyncHandler(async (req, res) => {
  const { chargeId, toFolioId } = req.body;
  if (!chargeId || !toFolioId) return res.status(400).json({ message: 'chargeId and toFolioId are required' });

  const { data: targetFolio } = await req.supabase.from('hotel_folios').select('id, status').eq('id', toFolioId).eq('business_id', req.params.businessId).single();
  if (!targetFolio) return res.status(404).json({ message: 'Target folio not found' });
  if (targetFolio.status === 'closed') return res.status(400).json({ message: 'Target folio is closed' });

  const { data, error } = await req.supabase
    .from('hotel_folio_charges')
    .update({ folio_id: toFolioId })
    .eq('id', chargeId)
    .eq('folio_id', req.params.folioId)
    .select()
    .single();
  if (error || !data) return res.status(400).json({ message: 'Could not transfer charge' });

  await logAction({ businessId: req.params.businessId, actor: req.user, action: 'folio_transferred', targetId: chargeId, details: { fromFolioId: req.params.folioId, toFolioId } });
  res.json(data);
});

// @route GET /api/businesses/:businessId/hotel/folios/lookup?roomNumber=814
// Room-number search for the POS "Charge to Room" flow - a waiter/staff
// member typing in a room number, not browsing a reservation list. Only
// ever returns a currently checked-in room's open primary folio, since
// that's the only thing a POS charge could legitimately land on.
const lookupFolioByRoom = asyncHandler(async (req, res) => {
  const roomNumber = String(req.query.roomNumber || '').trim();
  if (!roomNumber) return res.status(400).json({ message: 'roomNumber is required' });

  const { data: room } = await req.supabase
    .from('hotel_rooms')
    .select('id, room_number')
    .eq('business_id', req.params.businessId)
    .eq('room_number', roomNumber)
    .maybeSingle();
  if (!room) return res.status(404).json({ message: 'No room found with that number' });

  const { data: reservation } = await req.supabase
    .from('hotel_reservations')
    .select('id, hotel_guests(name)')
    .eq('room_id', room.id)
    .eq('status', 'checked_in')
    .maybeSingle();
  if (!reservation) return res.status(404).json({ message: 'That room has no checked-in guest right now' });

  const { data: folio } = await req.supabase
    .from('hotel_folios')
    .select('id')
    .eq('reservation_id', reservation.id)
    .eq('is_primary', true)
    .eq('status', 'open')
    .maybeSingle();
  if (!folio) return res.status(404).json({ message: 'No open folio for this room' });

  res.json({ folioId: folio.id, roomNumber: room.room_number, guestName: reservation.hotel_guests?.name || '' });
});

// @route GET /api/businesses/:businessId/hotel/tourism-dirham-report?from=&to=
// Every Tourism Dirham charge in range, plus the total - exactly what a
// DTCM auditor needs, generated straight from the same charges already
// posted at check-in, not a separate manually-tracked number.
const getTourismDirhamReport = asyncHandler(async (req, res) => {
  let query = req.supabase
    .from('hotel_folio_charges')
    .select('id, description, amount_aed, created_at, hotel_folios(reservation_id, hotel_reservations(hotel_rooms(room_number), hotel_guests(name)))')
    .eq('is_tourism_dirham', true)
    .order('created_at', { ascending: false });
  if (req.query.from) query = query.gte('created_at', req.query.from);
  if (req.query.to) query = query.lte('created_at', req.query.to);

  const { data, error } = await query;
  if (error) return res.status(400).json({ message: error.message });

  const total = (data || []).reduce((sum, c) => sum + Number(c.amount_aed), 0);
  res.json({ charges: data || [], total, count: (data || []).length });
});

module.exports = {
  getFolio, getFoliosByReservation, addCharge, deleteCharge, recordPayment,
  recordDeposit, recordRefund, recordAdjustment, splitFolio, transferCharge, lookupFolioByRoom, getTourismDirhamReport,
};

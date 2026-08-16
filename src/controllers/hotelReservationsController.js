const asyncHandler = require('../utils/asyncHandler');
const { logAction } = require('../utils/auditLog');
const { computeEffectiveRate } = require('./hotelRevenueController');
const { ensureCleaningTask } = require('./housekeepingController');

const listReservations = asyncHandler(async (req, res) => {
  let query = req.supabase
    .from('hotel_reservations')
    .select('*, hotel_guests(name, phone, email), hotel_rooms(room_number, room_type), hotel_booking_groups(id, group_name)')
    .eq('business_id', req.params.businessId)
    .order('check_in_date', { ascending: false });
  if (req.query.status) query = query.eq('status', req.query.status);
  if (req.query.bookingGroupId) query = query.eq('booking_group_id', req.query.bookingGroupId);
  const { data, error } = await query;
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// Real double-booking prevention: does any other active reservation
// (confirmed or checked_in) already hold this room for an overlapping
// date range? This is the "central inventory" requirement's internal
// half - syncing with actual OTAs needs a channel manager partner
// integration, scaffolded separately, but nothing should ever be able
// to double-book a room from inside Tavzio itself regardless of that.
async function hasOverlap(supabase, businessId, roomId, checkInDate, checkOutDate, excludeReservationId) {
  if (!roomId) return false;
  let query = supabase
    .from('hotel_reservations')
    .select('id, check_in_date, check_out_date')
    .eq('business_id', businessId)
    .eq('room_id', roomId)
    .in('status', ['confirmed', 'checked_in'])
    .lt('check_in_date', checkOutDate)
    .gt('check_out_date', checkInDate);
  if (excludeReservationId) query = query.neq('id', excludeReservationId);
  const { data } = await query;
  return (data || []).length > 0;
}

const createReservation = asyncHandler(async (req, res) => {
  const { guestId, roomId = null, checkInDate, checkOutDate, adults = 1, children = 0, source = 'direct', rateAed, ratePlanId = null, bookingGroupId = null } = req.body;
  if (!guestId || !checkInDate || !checkOutDate) {
    return res.status(400).json({ message: 'guestId, checkInDate, and checkOutDate are required' });
  }
  if (new Date(checkOutDate) <= new Date(checkInDate)) {
    return res.status(400).json({ message: 'checkOutDate must be after checkInDate' });
  }

  if (roomId && await hasOverlap(req.supabase, req.params.businessId, roomId, checkInDate, checkOutDate)) {
    return res.status(409).json({ message: 'This room is already booked for an overlapping date range' });
  }

  let resolvedRate = rateAed;
  // A rate plan's price for THIS specific date - a date-specific override
  // if one's set, then an occupancy-based surcharge on top if a pricing
  // rule applies - rather than just the plan's flat base_rate_aed. Only
  // engages when no explicit rateAed was given, same as the room-rate
  // fallback below it - an explicit rate always wins, deliberately.
  if (resolvedRate == null && ratePlanId) {
    const effective = await computeEffectiveRate(req.supabase, req.params.businessId, ratePlanId, checkInDate);
    resolvedRate = effective?.finalRateAed;
  }
  if (resolvedRate == null && roomId) {
    const { data: room } = await req.supabase.from('hotel_rooms').select('base_rate_aed').eq('id', roomId).single();
    resolvedRate = room?.base_rate_aed || 0;
  }

  const { data, error } = await req.supabase
    .from('hotel_reservations')
    .insert({
      business_id: req.params.businessId, guest_id: guestId, room_id: roomId,
      check_in_date: checkInDate, check_out_date: checkOutDate, adults, children, source,
      rate_aed: resolvedRate || 0, rate_plan_id: ratePlanId, booking_group_id: bookingGroupId,
    })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  await logAction({ businessId: req.params.businessId, actor: req.user, action: 'reservation_created', targetId: data.id, details: { checkInDate, checkOutDate, roomId, bookingGroupId } });
  res.status(201).json(data);
});

const checkIn = asyncHandler(async (req, res) => {
  const { roomId } = req.body;

  const { data: reservation } = await req.supabase
    .from('hotel_reservations')
    .select('*')
    .eq('id', req.params.reservationId)
    .eq('business_id', req.params.businessId)
    .single();
  if (!reservation) return res.status(404).json({ message: 'Reservation not found' });
  if (reservation.status !== 'confirmed') return res.status(400).json({ message: `Cannot check in a reservation with status "${reservation.status}"` });

  const finalRoomId = roomId || reservation.room_id;
  if (!finalRoomId) return res.status(400).json({ message: 'A room must be assigned to check in' });

  const { data: room } = await req.supabase.from('hotel_rooms').select('*').eq('id', finalRoomId).single();
  if (!room) return res.status(404).json({ message: 'Room not found' });
  // Real gap fixed here: this used to only block on 'occupied', which
  // meant a room sitting in 'maintenance' or 'out_of_order' - actively
  // broken, or physically unfit to sell - could still be checked a guest
  // into. Every non-available status blocks check-in now.
  if (room.status !== 'available') {
    const reason = room.status === 'occupied' ? 'is already occupied'
      : room.status === 'dirty' ? 'has not been cleaned yet'
      : room.status === 'maintenance' ? 'is currently under maintenance'
      : 'is out of order';
    return res.status(400).json({ message: `Room ${room.room_number} ${reason}` });
  }

  if (await hasOverlap(req.supabase, req.params.businessId, finalRoomId, reservation.check_in_date, reservation.check_out_date, reservation.id)) {
    return res.status(409).json({ message: 'This room now overlaps with another active reservation - assign a different room' });
  }

  const nights = Math.max(1, Math.round((new Date(reservation.check_out_date) - new Date(reservation.check_in_date)) / 86400000));
  const rate = reservation.rate_aed || room.base_rate_aed;

  const { data: updatedReservation, error } = await req.supabase
    .from('hotel_reservations')
    .update({ status: 'checked_in', room_id: finalRoomId, actual_check_in_at: new Date().toISOString(), rate_aed: rate })
    .eq('id', reservation.id)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  await req.supabase.from('hotel_rooms').update({ status: 'occupied' }).eq('id', finalRoomId);

  const { data: folio, error: folioError } = await req.supabase
    .from('hotel_folios')
    .insert({ business_id: req.params.businessId, reservation_id: reservation.id, is_primary: true })
    .select()
    .single();
  if (folioError) return res.status(400).json({ message: folioError.message });

  const roomCharges = Array.from({ length: nights }, (_, i) => ({
    folio_id: folio.id,
    description: `Room ${room.room_number} - night ${i + 1}`,
    amount_aed: rate,
    charge_type: 'room',
  }));
  await req.supabase.from('hotel_folio_charges').insert(roomCharges);

  // Tourism Dirham - a real Dubai/UAE DTCM-mandated per-room-night fee,
  // not a generic PMS line item. Only applied if the business has set a
  // rate (0 = not applicable/not set, e.g. outside Dubai or not yet
  // configured) - never silently charges a guest a fee the owner never
  // actually enabled. Tracked as its own charge type so it can be
  // reported on separately, exactly what a DTCM audit needs to see.
  const { data: business } = await req.supabase.from('businesses').select('tourism_dirham_rate_aed').eq('id', req.params.businessId).single();
  if (business?.tourism_dirham_rate_aed > 0) {
    const tourismDirhamCharges = Array.from({ length: nights }, (_, i) => ({
      folio_id: folio.id,
      description: `Tourism Dirham - night ${i + 1}`,
      amount_aed: business.tourism_dirham_rate_aed,
      charge_type: 'other',
      is_tourism_dirham: true,
    }));
    await req.supabase.from('hotel_folio_charges').insert(tourismDirhamCharges);
  }

  await logAction({ businessId: req.params.businessId, actor: req.user, action: 'reservation_checked_in', targetId: reservation.id, details: { roomId: finalRoomId, folioId: folio.id, nights } });
  res.json({ reservation: updatedReservation, folio });
});

const checkOut = asyncHandler(async (req, res) => {
  const { data: reservation } = await req.supabase
    .from('hotel_reservations')
    .select('*')
    .eq('id', req.params.reservationId)
    .eq('business_id', req.params.businessId)
    .single();
  if (!reservation) return res.status(404).json({ message: 'Reservation not found' });
  if (reservation.status !== 'checked_in') return res.status(400).json({ message: `Cannot check out a reservation with status "${reservation.status}"` });

  const { data: folios } = await req.supabase.from('hotel_folios').select('*').eq('reservation_id', reservation.id).eq('status', 'open');

  // Per-folio balance, not just one combined total - this is what makes
  // direct billing actually work: a guest-payer folio with money still
  // owed blocks checkout exactly as before (personal debt can't be
  // deferred without an account), but a company-payer folio's remaining
  // balance goes to the city ledger instead of blocking anything -
  // that's the entire point of a corporate account existing.
  const folioBalances = [];
  for (const folio of folios || []) {
    const { data: charges } = await req.supabase.from('hotel_folio_charges').select('amount_aed').eq('folio_id', folio.id);
    const balance = (charges || []).reduce((sum, c) => sum + Number(c.amount_aed), 0);
    folioBalances.push({ folio, balance });
  }

  const blockingFolio = folioBalances.find((f) => f.balance > 0 && f.folio.payer_type !== 'company');
  if (blockingFolio) {
    return res.status(400).json({ message: `Cannot check out - outstanding balance of AED ${blockingFolio.balance.toFixed(2)} on the guest folio. Record payment first.` });
  }

  for (const { folio, balance } of folioBalances) {
    if (folio.payer_type === 'company' && balance > 0) {
      await req.supabase.from('hotel_folios').update({ status: 'billed_to_account', closed_at: new Date().toISOString() }).eq('id', folio.id);
      await req.supabase.from('hotel_city_ledger_entries').insert({
        business_id: req.params.businessId, folio_id: folio.id,
        company_name: folio.company_name || 'Unnamed company', amount_aed: balance,
      });
    } else {
      await req.supabase.from('hotel_folios').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('id', folio.id);
    }
  }

  const { data: updated, error } = await req.supabase
    .from('hotel_reservations')
    .update({ status: 'checked_out', actual_check_out_at: new Date().toISOString() })
    .eq('id', reservation.id)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  if (reservation.room_id) {
    await req.supabase.from('hotel_rooms').update({ status: 'dirty' }).eq('id', reservation.room_id);
    await ensureCleaningTask(req.supabase, req.params.businessId, reservation.room_id);
  }

  await logAction({ businessId: req.params.businessId, actor: req.user, action: 'reservation_checked_out', targetId: reservation.id, details: { foliosClosed: (folios || []).length } });
  res.json(updated);
});

const cancelReservation = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('hotel_reservations')
    .update({ status: 'cancelled' })
    .eq('id', req.params.reservationId)
    .eq('business_id', req.params.businessId)
    .eq('status', 'confirmed')
    .select()
    .single();
  if (error || !data) return res.status(400).json({ message: 'Could not cancel - only a confirmed (not yet checked-in) reservation can be cancelled' });

  await logAction({ businessId: req.params.businessId, actor: req.user, action: 'reservation_cancelled', targetId: data.id, details: {} });
  res.json(data);
});

// @route POST /api/businesses/:businessId/hotel/reservations/:reservationId/no-show
// The DB has always allowed a 'no_show' status - nothing ever set it.
// Distinct from cancellation: a no-show is a guest who never arrived
// for a confirmed booking, kept as its own fact for reporting (no-show
// rate is a real metric hotels track, separate from cancellation rate).
// No room to release - a confirmed (not yet checked-in) reservation
// never occupied a room in the first place.
const markNoShow = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('hotel_reservations')
    .update({ status: 'no_show' })
    .eq('id', req.params.reservationId)
    .eq('business_id', req.params.businessId)
    .eq('status', 'confirmed')
    .select()
    .single();
  if (error || !data) return res.status(400).json({ message: 'Could not mark no-show - only a confirmed (not yet checked-in) reservation can be' });

  await logAction({ businessId: req.params.businessId, actor: req.user, action: 'reservation_no_show', targetId: data.id, details: {} });
  res.json(data);
});

// @route PATCH /api/businesses/:businessId/hotel/reservations/:reservationId
// Body: { checkInDate?, checkOutDate?, roomId?, rateAed? }
// Two very different cases depending on status, both real gaps that
// only "cancel and rebook" used to cover:
//
// - 'confirmed' (pre-arrival): everything is editable - dates, room,
//   rate - re-validated against the same overlap check createReservation
//   uses. No folio exists yet, so nothing else to touch.
// - 'checked_in': only checkOutDate can change here (extending or
//   shortening an in-progress stay). Room changes go through the
//   separate room-transfer endpoint below, since that also has to move
//   physical room status, not just a date. Extending automatically adds
//   the new nights' room charges to the folio, at the reservation's
//   existing rate - the same math checkIn already used to create the
//   original charges. Shortening does NOT auto-remove already-created
//   charges (deleting billing lines automatically is a real money
//   operation this endpoint has no business doing silently) - staff
//   remove the extra night(s) from the folio directly if needed, same
//   as removing any other mistaken charge.
const modifyReservation = asyncHandler(async (req, res) => {
  const { checkInDate, checkOutDate, roomId, rateAed } = req.body;

  const { data: reservation } = await req.supabase
    .from('hotel_reservations')
    .select('*')
    .eq('id', req.params.reservationId)
    .eq('business_id', req.params.businessId)
    .single();
  if (!reservation) return res.status(404).json({ message: 'Reservation not found' });

  if (reservation.status === 'confirmed') {
    const newCheckIn = checkInDate || reservation.check_in_date;
    const newCheckOut = checkOutDate || reservation.check_out_date;
    const newRoomId = roomId !== undefined ? roomId : reservation.room_id;
    if (new Date(newCheckOut) <= new Date(newCheckIn)) {
      return res.status(400).json({ message: 'checkOutDate must be after checkInDate' });
    }
    if (newRoomId && await hasOverlap(req.supabase, req.params.businessId, newRoomId, newCheckIn, newCheckOut, reservation.id)) {
      return res.status(409).json({ message: 'This room is already booked for an overlapping date range' });
    }
    const update = { check_in_date: newCheckIn, check_out_date: newCheckOut, room_id: newRoomId };
    if (rateAed != null) update.rate_aed = rateAed;

    const { data, error } = await req.supabase.from('hotel_reservations').update(update).eq('id', reservation.id).select().single();
    if (error) return res.status(400).json({ message: error.message });
    await logAction({ businessId: req.params.businessId, actor: req.user, action: 'reservation_modified', targetId: data.id, details: { checkInDate: newCheckIn, checkOutDate: newCheckOut, roomId: newRoomId } });
    return res.json(data);
  }

  if (reservation.status === 'checked_in') {
    if (!checkOutDate) return res.status(400).json({ message: 'Only checkOutDate can be changed on a checked-in stay - use the room-transfer endpoint to change rooms' });
    if (new Date(checkOutDate) <= new Date(reservation.check_in_date)) {
      return res.status(400).json({ message: 'checkOutDate must be after the original check-in date' });
    }
    if (reservation.room_id && await hasOverlap(req.supabase, req.params.businessId, reservation.room_id, reservation.check_in_date, checkOutDate, reservation.id)) {
      return res.status(409).json({ message: 'Extending into this date range conflicts with another reservation for this room' });
    }

    const oldNights = Math.max(1, Math.round((new Date(reservation.check_out_date) - new Date(reservation.check_in_date)) / 86400000));
    const newNights = Math.max(1, Math.round((new Date(checkOutDate) - new Date(reservation.check_in_date)) / 86400000));

    const { data: updated, error } = await req.supabase.from('hotel_reservations').update({ check_out_date: checkOutDate }).eq('id', reservation.id).select().single();
    if (error) return res.status(400).json({ message: error.message });

    if (newNights > oldNights) {
      const { data: folio } = await req.supabase.from('hotel_folios').select('id').eq('reservation_id', reservation.id).eq('is_primary', true).maybeSingle();
      const { data: room } = await req.supabase.from('hotel_rooms').select('room_number').eq('id', reservation.room_id).maybeSingle();
      if (folio) {
        const addedNights = newNights - oldNights;
        const extraCharges = Array.from({ length: addedNights }, (_, i) => ({
          folio_id: folio.id,
          description: `Room ${room?.room_number || ''} - night ${oldNights + i + 1} (stay extended)`,
          amount_aed: reservation.rate_aed,
          charge_type: 'room',
        }));
        await req.supabase.from('hotel_folio_charges').insert(extraCharges);
      }
    }

    await logAction({ businessId: req.params.businessId, actor: req.user, action: 'reservation_modified', targetId: updated.id, details: { newCheckOutDate: checkOutDate, oldNights, newNights } });
    return res.json(updated);
  }

  return res.status(400).json({ message: `Cannot modify a reservation with status "${reservation.status}"` });
});

// @route POST /api/businesses/:businessId/hotel/reservations/:reservationId/transfer-room
// Body: { newRoomId }
// Moves a checked-in guest to a different room - operational move only
// (physical room status + the reservation's room_id), deliberately does
// NOT touch the folio. Already-billed nights stay billed as they were;
// a rate change from the move is a deliberate manual adjustment staff
// make on the folio if the new room's rate genuinely differs, not
// something this endpoint should silently decide on its own.
const transferRoom = asyncHandler(async (req, res) => {
  const { newRoomId } = req.body;
  if (!newRoomId) return res.status(400).json({ message: 'newRoomId is required' });

  const { data: reservation } = await req.supabase
    .from('hotel_reservations')
    .select('*')
    .eq('id', req.params.reservationId)
    .eq('business_id', req.params.businessId)
    .single();
  if (!reservation) return res.status(404).json({ message: 'Reservation not found' });
  if (reservation.status !== 'checked_in') return res.status(400).json({ message: 'Only a checked-in reservation can be transferred to a new room' });
  if (newRoomId === reservation.room_id) return res.status(400).json({ message: 'Guest is already in this room' });

  const { data: newRoom } = await req.supabase.from('hotel_rooms').select('*').eq('id', newRoomId).eq('business_id', req.params.businessId).single();
  if (!newRoom) return res.status(404).json({ message: 'Room not found' });
  if (newRoom.status !== 'available') {
    const reason = newRoom.status === 'occupied' ? 'is already occupied'
      : newRoom.status === 'dirty' ? 'has not been cleaned yet'
      : newRoom.status === 'maintenance' ? 'is currently under maintenance'
      : 'is out of order';
    return res.status(400).json({ message: `Room ${newRoom.room_number} ${reason}` });
  }

  if (await hasOverlap(req.supabase, req.params.businessId, newRoomId, reservation.check_in_date, reservation.check_out_date, reservation.id)) {
    return res.status(409).json({ message: 'The new room has a conflicting reservation for these dates' });
  }

  const oldRoomId = reservation.room_id;
  const { data: updated, error } = await req.supabase
    .from('hotel_reservations')
    .update({ room_id: newRoomId })
    .eq('id', reservation.id)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  await req.supabase.from('hotel_rooms').update({ status: 'occupied' }).eq('id', newRoomId);
  // Old room needs housekeeping's attention before anyone else moves in,
  // exactly like a real checkout - same status a guest departing entirely
  // leaves the room in.
  if (oldRoomId) {
    await req.supabase.from('hotel_rooms').update({ status: 'dirty' }).eq('id', oldRoomId);
    await ensureCleaningTask(req.supabase, req.params.businessId, oldRoomId);
  }

  await logAction({ businessId: req.params.businessId, actor: req.user, action: 'reservation_room_transferred', targetId: reservation.id, details: { oldRoomId, newRoomId } });
  res.json(updated);
});

module.exports = { listReservations, createReservation, checkIn, checkOut, cancelReservation, markNoShow, modifyReservation, transferRoom };

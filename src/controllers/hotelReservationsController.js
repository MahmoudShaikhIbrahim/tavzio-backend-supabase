const asyncHandler = require('../utils/asyncHandler');
const { logAction } = require('../utils/auditLog');

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
  if (resolvedRate == null && ratePlanId) {
    const { data: plan } = await req.supabase.from('hotel_rate_plans').select('base_rate_aed').eq('id', ratePlanId).single();
    resolvedRate = plan?.base_rate_aed;
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
  if (room.status === 'occupied') return res.status(400).json({ message: `Room ${room.room_number} is already occupied` });

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
  let totalBalance = 0;
  for (const folio of folios || []) {
    const { data: charges } = await req.supabase.from('hotel_folio_charges').select('amount_aed').eq('folio_id', folio.id);
    totalBalance += (charges || []).reduce((sum, c) => sum + Number(c.amount_aed), 0);
  }
  if (totalBalance > 0) {
    return res.status(400).json({ message: `Cannot check out - outstanding balance of AED ${totalBalance.toFixed(2)} across ${(folios || []).length} folio(s). Record payment first.` });
  }
  for (const folio of folios || []) {
    await req.supabase.from('hotel_folios').update({ status: 'closed', closed_at: new Date().toISOString() }).eq('id', folio.id);
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

module.exports = { listReservations, createReservation, checkIn, checkOut, cancelReservation };

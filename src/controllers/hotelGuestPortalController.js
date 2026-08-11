const asyncHandler = require('../utils/asyncHandler');
const { supabaseAdmin } = require('../config/supabaseClient');

const getGuestPortal = asyncHandler(async (req, res) => {
  const { data: business } = await supabaseAdmin
    .from('businesses')
    .select('id, name, slug, logo_url, links, theme, category')
    .eq('slug', req.params.slug)
    .eq('status', 'active')
    .single();
  if (!business || business.category !== 'hotel') return res.status(404).json({ message: 'Not found' });

  const { data: room } = await supabaseAdmin
    .from('hotel_rooms')
    .select('id, room_number, room_type, status')
    .eq('id', req.params.roomId)
    .eq('business_id', business.id)
    .single();
  if (!room) return res.status(404).json({ message: 'Room not found' });

  const { data: reservation } = await supabaseAdmin
    .from('hotel_reservations')
    .select('id, check_in_date, check_out_date, hotel_guests(name)')
    .eq('room_id', room.id)
    .eq('status', 'checked_in')
    .maybeSingle();

  let folioBalance = null;
  let primaryFolioId = null;
  if (reservation) {
    const { data: folio } = await supabaseAdmin
      .from('hotel_folios')
      .select('id, hotel_folio_charges(amount_aed)')
      .eq('reservation_id', reservation.id)
      .eq('is_primary', true)
      .eq('status', 'open')
      .maybeSingle();
    if (folio) {
      primaryFolioId = folio.id;
      folioBalance = (folio.hotel_folio_charges || []).reduce((sum, c) => sum + Number(c.amount_aed), 0);
    }
  }

  res.json({
    business: { name: business.name, slug: business.slug, logoUrl: business.logo_url, links: business.links, theme: business.theme },
    room: { id: room.id, roomNumber: room.room_number, roomType: room.room_type },
    guest: reservation ? { name: reservation.hotel_guests?.name, checkInDate: reservation.check_in_date, checkOutDate: reservation.check_out_date } : null,
    folioId: primaryFolioId,
    folioBalance,
  });
});

const submitGuestRequest = asyncHandler(async (req, res) => {
  const { requestType = 'other', note = '' } = req.body;

  const { data: business } = await supabaseAdmin.from('businesses').select('id, category').eq('slug', req.params.slug).eq('status', 'active').single();
  if (!business || business.category !== 'hotel') return res.status(404).json({ message: 'Not found' });

  const { data: room } = await supabaseAdmin.from('hotel_rooms').select('id').eq('id', req.params.roomId).eq('business_id', business.id).single();
  if (!room) return res.status(404).json({ message: 'Room not found' });

  const { data: reservation } = await supabaseAdmin.from('hotel_reservations').select('id').eq('room_id', room.id).eq('status', 'checked_in').maybeSingle();

  const { data, error } = await supabaseAdmin
    .from('guest_service_requests')
    .insert({ business_id: business.id, room_id: room.id, reservation_id: reservation?.id || null, request_type: requestType, note })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json({ message: 'Request received - our team has been notified.', request: data });
});

module.exports = { getGuestPortal, submitGuestRequest };

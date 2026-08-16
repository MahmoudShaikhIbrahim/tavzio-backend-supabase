const asyncHandler = require('../utils/asyncHandler');

const listGuests = asyncHandler(async (req, res) => {
  let query = req.supabase.from('hotel_guests').select('*').eq('business_id', req.params.businessId).order('name');
  if (req.query.search) query = query.ilike('name', `%${req.query.search}%`);
  const { data, error } = await query;
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route GET /api/businesses/:businessId/hotel/guests/match?phone=
// The real fix for guest history fragmenting across duplicate records:
// front desk checks this BEFORE creating a new guest, so a repeat
// visitor gets matched to their existing profile (and its stay history)
// instead of a fresh blank one every time. Exact phone match only -
// deliberately not fuzzy/name-based, since a wrong guess here would
// attach a new reservation to a stranger's profile, which is worse than
// occasionally missing a real match.
const matchGuestByPhone = asyncHandler(async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.json([]);
  const { data, error } = await req.supabase
    .from('hotel_guests')
    .select('*')
    .eq('business_id', req.params.businessId)
    .eq('phone', phone);
  if (error) return res.status(400).json({ message: error.message });
  res.json(data || []);
});

const createGuest = asyncHandler(async (req, res) => {
  const { name, email = '', phone = '', idDocumentType = '', idDocumentNumber = '', nationality = '', notes = '', vip = false, roomPreference = '', dietaryNotes = '' } = req.body;
  if (!name) return res.status(400).json({ message: 'name is required' });
  const { data, error } = await req.supabase
    .from('hotel_guests')
    .insert({
      business_id: req.params.businessId, name, email, phone,
      id_document_type: idDocumentType, id_document_number: idDocumentNumber, nationality, notes,
      vip, room_preference: roomPreference, dietary_notes: dietaryNotes,
    })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

const updateGuest = asyncHandler(async (req, res) => {
  const { name, email, phone, idDocumentType, idDocumentNumber, nationality, notes, vip, roomPreference, dietaryNotes } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (email !== undefined) update.email = email;
  if (phone !== undefined) update.phone = phone;
  if (idDocumentType !== undefined) update.id_document_type = idDocumentType;
  if (idDocumentNumber !== undefined) update.id_document_number = idDocumentNumber;
  if (nationality !== undefined) update.nationality = nationality;
  if (notes !== undefined) update.notes = notes;
  if (vip !== undefined) update.vip = vip;
  if (roomPreference !== undefined) update.room_preference = roomPreference;
  if (dietaryNotes !== undefined) update.dietary_notes = dietaryNotes;

  const { data, error } = await req.supabase
    .from('hotel_guests')
    .update(update)
    .eq('id', req.params.guestId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route GET /api/businesses/:businessId/hotel/guests/:guestId/stays
// Full stay history plus lifetime totals - the actual "guest CRM" part:
// every past reservation for this guest, and what they're worth in
// total nights and spend. Spend is summed from each stay's own folio
// charges (what was actually billed), not just rate_aed * nights, so it
// reflects real extras/discounts/adjustments rather than a theoretical number.
const getGuestStayHistory = asyncHandler(async (req, res) => {
  const { data: reservations, error } = await req.supabase
    .from('hotel_reservations')
    .select('*, hotel_rooms(room_number, room_type), hotel_folios(id)')
    .eq('guest_id', req.params.guestId)
    .eq('business_id', req.params.businessId)
    .order('check_in_date', { ascending: false });
  if (error) return res.status(400).json({ message: error.message });

  const folioIds = (reservations || []).flatMap((r) => (r.hotel_folios || []).map((f) => f.id));
  let chargesByFolio = new Map();
  if (folioIds.length > 0) {
    const { data: charges } = await req.supabase.from('hotel_folio_charges').select('folio_id, amount_aed').in('folio_id', folioIds);
    for (const c of charges || []) {
      chargesByFolio.set(c.folio_id, (chargesByFolio.get(c.folio_id) || 0) + Number(c.amount_aed));
    }
  }

  const stays = (reservations || []).map((r) => {
    const nights = Math.max(1, Math.round((new Date(r.check_out_date) - new Date(r.check_in_date)) / 86400000));
    const spendAed = (r.hotel_folios || []).reduce((sum, f) => sum + (chargesByFolio.get(f.id) || 0), 0);
    return {
      reservationId: r.id,
      checkInDate: r.check_in_date,
      checkOutDate: r.check_out_date,
      nights,
      status: r.status,
      roomNumber: r.hotel_rooms?.room_number || null,
      roomType: r.hotel_rooms?.room_type || null,
      spendAed: Math.round(spendAed * 100) / 100,
    };
  });

  const completedStays = stays.filter((s) => s.status === 'checked_out');
  res.json({
    stays,
    totalStays: completedStays.length,
    totalNights: completedStays.reduce((sum, s) => sum + s.nights, 0),
    lifetimeSpendAed: Math.round(completedStays.reduce((sum, s) => sum + s.spendAed, 0) * 100) / 100,
  });
});

module.exports = { listGuests, matchGuestByPhone, createGuest, updateGuest, getGuestStayHistory };

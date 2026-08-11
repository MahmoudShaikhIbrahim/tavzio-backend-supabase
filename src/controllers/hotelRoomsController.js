const asyncHandler = require('../utils/asyncHandler');

const listRooms = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('hotel_rooms')
    .select('*, cards(id, uid, label, status)')
    .eq('business_id', req.params.businessId)
    .order('room_number');
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/hotel/rooms
// Body: { roomNumber, roomType, floor, maxOccupancy, baseRateAed, cardId? }
// A room can be linked to its physical NFC stand at creation (if the
// stand's already been issued and is sitting unused) or any time after
// from the Rooms list - never assumed or auto-matched by number/label,
// since a wrong auto-match would silently route a guest into someone
// else's room.
const createRoom = asyncHandler(async (req, res) => {
  const { roomNumber, roomType = 'standard', floor = '', maxOccupancy = 2, baseRateAed = 0, cardId } = req.body;
  if (!roomNumber) return res.status(400).json({ message: 'roomNumber is required' });
  const { data, error } = await req.supabase
    .from('hotel_rooms')
    .insert({ business_id: req.params.businessId, room_number: roomNumber, room_type: roomType, floor, max_occupancy: maxOccupancy, base_rate_aed: baseRateAed })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  if (cardId) {
    await req.supabase.from('cards').update({ room_id: data.id }).eq('id', cardId).eq('business_id', req.params.businessId);
  }

  res.status(201).json(data);
});

const updateRoom = asyncHandler(async (req, res) => {
  const { roomNumber, roomType, floor, maxOccupancy, baseRateAed, status } = req.body;
  const update = {};
  if (roomNumber !== undefined) update.room_number = roomNumber;
  if (roomType !== undefined) update.room_type = roomType;
  if (floor !== undefined) update.floor = floor;
  if (maxOccupancy !== undefined) update.max_occupancy = maxOccupancy;
  if (baseRateAed !== undefined) update.base_rate_aed = baseRateAed;
  if (status !== undefined) update.status = status;

  const { data, error } = await req.supabase
    .from('hotel_rooms')
    .update(update)
    .eq('id', req.params.roomId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

module.exports = { listRooms, createRoom, updateRoom };

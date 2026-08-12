const asyncHandler = require('../utils/asyncHandler');
const { logAction } = require('../utils/auditLog');

// @route GET /api/businesses/:businessId/hotel/booking-groups
const listBookingGroups = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('hotel_booking_groups')
    .select('*, hotel_reservations(id, status, check_in_date, check_out_date, hotel_rooms(room_number), hotel_guests(name))')
    .eq('business_id', req.params.businessId)
    .order('created_at', { ascending: false });
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/hotel/booking-groups
// Body: { groupName, contactName, contactPhone, contactEmail, notes }
// Just the group shell - rooms are added to it afterward via
// createReservation's bookingGroupId, same as any other reservation,
// so this reuses all the normal booking logic (overlap checks, rate
// resolution) rather than duplicating it for the group case.
const createBookingGroup = asyncHandler(async (req, res) => {
  const { groupName, contactName = '', contactPhone = '', contactEmail = '', notes = '' } = req.body;
  if (!groupName) return res.status(400).json({ message: 'groupName is required' });
  const { data, error } = await req.supabase
    .from('hotel_booking_groups')
    .insert({ business_id: req.params.businessId, group_name: groupName, contact_name: contactName, contact_phone: contactPhone, contact_email: contactEmail, notes })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  await logAction({ businessId: req.params.businessId, actor: req.user, action: 'booking_group_created', targetId: data.id, details: { groupName } });
  res.status(201).json(data);
});

const updateBookingGroup = asyncHandler(async (req, res) => {
  const { groupName, contactName, contactPhone, contactEmail, notes } = req.body;
  const update = {};
  if (groupName !== undefined) update.group_name = groupName;
  if (contactName !== undefined) update.contact_name = contactName;
  if (contactPhone !== undefined) update.contact_phone = contactPhone;
  if (contactEmail !== undefined) update.contact_email = contactEmail;
  if (notes !== undefined) update.notes = notes;

  const { data, error } = await req.supabase
    .from('hotel_booking_groups')
    .update(update)
    .eq('id', req.params.groupId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ message: 'Booking group not found' });
  res.json(data);
});

// Deleting the group never touches its reservations - they just fall
// back to being standalone (booking_group_id set null via the FK's "on
// delete set null"), never cancelled as a side effect of un-grouping them.
const deleteBookingGroup = asyncHandler(async (req, res) => {
  const { error, count } = await req.supabase
    .from('hotel_booking_groups')
    .delete({ count: 'exact' })
    .eq('id', req.params.groupId)
    .eq('business_id', req.params.businessId);
  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Booking group not found' });
  res.json({ message: 'Booking group deleted - its reservations remain, just no longer grouped' });
});

module.exports = { listBookingGroups, createBookingGroup, updateBookingGroup, deleteBookingGroup };

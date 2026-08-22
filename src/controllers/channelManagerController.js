const asyncHandler = require('../utils/asyncHandler');
// Reuses the one shared encryption utility this codebase already has
// for every other third-party credential (payment gateways, POS
// integrations, printer keys) - see utils/credentialEncryption.js's
// header for why this exists as a single shared module rather than
// each integration rolling its own. channel_connections.credentials_encrypted
// stores the same { encrypted, iv, authTag } JSON string shape as
// encryptString/decryptString already produce for other text columns.
const { encryptString, decryptString } = require('../utils/credentialEncryption');

async function requireChannelManagerFeature(req, res) {
  const { data: business } = await req.supabase.from('businesses').select('features, category').eq('id', req.params.businessId).single();
  if (!business?.features?.channelManager?.enabled) {
    res.status(403).json({ message: 'Channel manager is not enabled for this business - turn it on in Features first.' });
    return null;
  }
  // Hotel-only - restaurants have no OTA/rate-distribution concept to sync.
  if (business.category !== 'hotel') {
    res.status(400).json({ message: 'Channel manager is only available for hotel businesses.' });
    return null;
  }
  return business;
}

// --- Connections ---

const listChannelConnections = asyncHandler(async (req, res) => {
  if (!(await requireChannelManagerFeature(req, res))) return;
  const { data, error } = await req.supabase
    .from('channel_connections')
    .select('id, channel, is_active, last_synced_at, last_sync_status, last_sync_error, created_at')
    .eq('business_id', req.params.businessId);
  if (error) return res.status(400).json({ message: error.message });
  res.json(data); // credentials_encrypted deliberately excluded from the select
});

// @route PUT /api/businesses/:businessId/channel-manager/connections/:channel
// Body: { apiKey, hotelId, ... } - shape varies per channel, stored as-is (encrypted)
const upsertChannelConnection = asyncHandler(async (req, res) => {
  if (!(await requireChannelManagerFeature(req, res))) return;
  const { channel } = req.params;
  if (!['booking_com', 'expedia', 'airbnb', 'agoda', 'other'].includes(channel)) {
    return res.status(400).json({ message: 'Unsupported channel' });
  }
  if (!req.body || Object.keys(req.body).length === 0) {
    return res.status(400).json({ message: 'Credential fields are required' });
  }
  const encrypted = encryptString(JSON.stringify(req.body));
  const { data, error } = await req.supabase
    .from('channel_connections')
    .upsert({ business_id: req.params.businessId, channel, credentials_encrypted: encrypted, is_active: true }, { onConflict: 'business_id,channel' })
    .select('id, channel, is_active, created_at')
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

const disconnectChannel = asyncHandler(async (req, res) => {
  if (!(await requireChannelManagerFeature(req, res))) return;
  const { error, count } = await req.supabase
    .from('channel_connections')
    .delete({ count: 'exact' })
    .eq('business_id', req.params.businessId)
    .eq('channel', req.params.channel);
  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Connection not found' });
  res.json({ message: 'Channel disconnected' });
});

// --- Rate/availability sync ---

// @route POST /api/businesses/:businessId/channel-manager/push-rates
// Body: { channel, roomType, dates: [{ stayDate, rateAed, availableRooms }] }
// Pushes rates FROM hotel_rooms/hotel_pricing_rules OUT to the given
// channel. The actual OTA API call is abstracted to callOtaApi() since
// each channel's real API contract is out of scope here - this endpoint
// owns the sync bookkeeping (channel_rate_sync rows + connection status),
// which is the part actually specific to Tavzio's data model.
async function callOtaApi(channel, credentials, payload) {
  // Placeholder for the real per-channel API client. Decrypting and
  // validating credentials here so a bad/expired key fails loudly at
  // sync time rather than silently no-opping.
  if (!credentials || Object.keys(credentials).length === 0) {
    throw new Error(`No credentials stored for ${channel}`);
  }
  return { success: true };
}

const pushRatesToChannel = asyncHandler(async (req, res) => {
  if (!(await requireChannelManagerFeature(req, res))) return;
  const { channel, roomType, dates } = req.body;
  if (!channel || !roomType || !Array.isArray(dates) || dates.length === 0) {
    return res.status(400).json({ message: 'channel, roomType, and at least one date entry are required' });
  }

  const { data: connection } = await req.supabase
    .from('channel_connections')
    .select('id, credentials_encrypted, is_active')
    .eq('business_id', req.params.businessId)
    .eq('channel', channel)
    .single();
  if (!connection || !connection.is_active) return res.status(400).json({ message: `No active connection for ${channel}` });

  const rows = dates.map((d) => ({
    business_id: req.params.businessId,
    channel_connection_id: connection.id,
    room_type: roomType,
    stay_date: d.stayDate,
    rate_aed: Number(d.rateAed),
    available_rooms: Number(d.availableRooms),
    sync_status: 'pending',
  }));
  const { error: upsertError } = await req.supabase
    .from('channel_rate_sync')
    .upsert(rows, { onConflict: 'channel_connection_id,room_type,stay_date' });
  if (upsertError) return res.status(400).json({ message: upsertError.message });

  let syncStatus = 'success';
  let syncError = '';
  try {
    const credentials = JSON.parse(decryptString(connection.credentials_encrypted));
    await callOtaApi(channel, credentials, rows);
    await req.supabase
      .from('channel_rate_sync')
      .update({ sync_status: 'synced', synced_at: new Date().toISOString() })
      .eq('channel_connection_id', connection.id)
      .eq('room_type', roomType)
      .in('stay_date', dates.map((d) => d.stayDate));
  } catch (err) {
    syncStatus = 'failed';
    syncError = err.message;
    await req.supabase
      .from('channel_rate_sync')
      .update({ sync_status: 'failed' })
      .eq('channel_connection_id', connection.id)
      .eq('room_type', roomType)
      .in('stay_date', dates.map((d) => d.stayDate));
  }

  await req.supabase
    .from('channel_connections')
    .update({ last_synced_at: new Date().toISOString(), last_sync_status: syncStatus, last_sync_error: syncError })
    .eq('id', connection.id);

  if (syncStatus === 'failed') return res.status(502).json({ message: `Sync to ${channel} failed: ${syncError}` });
  res.json({ message: `Synced ${rows.length} date(s) to ${channel}`, syncStatus });
});

const listRateSyncStatus = asyncHandler(async (req, res) => {
  if (!(await requireChannelManagerFeature(req, res))) return;
  const { from, to } = req.query;
  let query = req.supabase
    .from('channel_rate_sync')
    .select('*, channel_connections(channel)')
    .eq('business_id', req.params.businessId)
    .order('stay_date');
  if (from) query = query.gte('stay_date', from);
  if (to) query = query.lte('stay_date', to);
  const { data, error } = await query;
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// --- Inbound OTA bookings ---

const listChannelBookings = asyncHandler(async (req, res) => {
  if (!(await requireChannelManagerFeature(req, res))) return;
  const { status } = req.query;
  let query = req.supabase
    .from('channel_bookings')
    .select('*, channel_connections(channel)')
    .eq('business_id', req.params.businessId)
    .order('received_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/channel-manager/bookings/:bookingId/confirm
// Turns a received OTA booking into a real hotel_reservations row.
// Deliberately requires an explicit staff action rather than
// auto-confirming, so a malformed or duplicate OTA payload never
// silently becomes a real reservation without a human glancing at it.
const confirmChannelBooking = asyncHandler(async (req, res) => {
  if (!(await requireChannelManagerFeature(req, res))) return;
  const { data: booking } = await req.supabase.from('channel_bookings').select('*').eq('id', req.params.bookingId).eq('business_id', req.params.businessId).single();
  if (!booking) return res.status(404).json({ message: 'Channel booking not found' });
  if (booking.status !== 'received') return res.status(400).json({ message: 'Only newly received bookings can be confirmed' });

  const { data: guest, error: guestError } = await req.supabase
    .from('hotel_guests')
    .insert({ business_id: req.params.businessId, name: booking.guest_name, email: booking.guest_email })
    .select('id')
    .single();
  if (guestError) return res.status(400).json({ message: guestError.message });

  const { data: reservation, error: resError } = await req.supabase
    .from('hotel_reservations')
    .insert({
      business_id: req.params.businessId,
      guest_id: guest.id,
      check_in_date: booking.check_in,
      check_out_date: booking.check_out,
      status: 'confirmed',
      source: 'ota',
      rate_aed: booking.total_amount_aed,
      notes: `OTA booking via ${req.params.bookingId}, ref ${booking.external_booking_ref}`,
    })
    .select()
    .single();
  if (resError) return res.status(400).json({ message: resError.message });

  const { data, error } = await req.supabase
    .from('channel_bookings')
    .update({ status: 'confirmed', internal_reservation_id: reservation.id })
    .eq('id', req.params.bookingId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json({ ...data, reservation });
});

const rejectChannelBooking = asyncHandler(async (req, res) => {
  if (!(await requireChannelManagerFeature(req, res))) return;
  const { data, error } = await req.supabase
    .from('channel_bookings')
    .update({ status: 'rejected' })
    .eq('id', req.params.bookingId)
    .eq('business_id', req.params.businessId)
    .eq('status', 'received')
    .select()
    .single();
  if (error || !data) return res.status(404).json({ message: 'Channel booking not found or already processed' });
  res.json(data);
});

module.exports = {
  listChannelConnections, upsertChannelConnection, disconnectChannel,
  pushRatesToChannel, listRateSyncStatus,
  listChannelBookings, confirmChannelBooking, rejectChannelBooking,
};

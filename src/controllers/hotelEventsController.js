const asyncHandler = require('../utils/asyncHandler');
const { logAction } = require('../utils/auditLog');

// --- Event spaces (function rooms, ballrooms, meeting rooms) ---

const listEventSpaces = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase.from('hotel_event_spaces').select('*').eq('business_id', req.params.businessId).order('name');
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

const createEventSpace = asyncHandler(async (req, res) => {
  const { name, capacity = 0, hourlyRateAed = 0, description = '' } = req.body;
  if (!name) return res.status(400).json({ message: 'name is required' });
  const { data, error } = await req.supabase
    .from('hotel_event_spaces')
    .insert({ business_id: req.params.businessId, name, capacity, hourly_rate_aed: hourlyRateAed, description })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

const updateEventSpace = asyncHandler(async (req, res) => {
  const { name, capacity, hourlyRateAed, description, active } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (capacity !== undefined) update.capacity = capacity;
  if (hourlyRateAed !== undefined) update.hourly_rate_aed = hourlyRateAed;
  if (description !== undefined) update.description = description;
  if (active !== undefined) update.active = active;
  const { data, error } = await req.supabase
    .from('hotel_event_spaces')
    .update(update)
    .eq('id', req.params.spaceId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ message: 'Event space not found' });
  res.json(data);
});

// --- Events (the sales pipeline itself) ---

// Same double-booking prevention pattern hotel_reservations already
// uses for rooms - only checked against 'tentative'/'confirmed' events,
// since an 'inquiry' hasn't actually claimed the space yet (several
// inquiries for the same date/space is normal - only one of them wins).
async function hasEventOverlap(supabase, businessId, eventSpaceId, eventDate, startTime, endTime, excludeEventId) {
  if (!eventSpaceId) return false;
  let query = supabase
    .from('hotel_events')
    .select('id, start_time, end_time')
    .eq('business_id', businessId)
    .eq('event_space_id', eventSpaceId)
    .eq('event_date', eventDate)
    .in('status', ['tentative', 'confirmed'])
    .lt('start_time', endTime)
    .gt('end_time', startTime);
  if (excludeEventId) query = query.neq('id', excludeEventId);
  const { data } = await query;
  return (data || []).length > 0;
}

// @route GET /api/businesses/:businessId/hotel/events?from=&to=&status=
const listEvents = asyncHandler(async (req, res) => {
  let query = req.supabase
    .from('hotel_events')
    .select('*, hotel_event_spaces(name, capacity)')
    .eq('business_id', req.params.businessId)
    .order('event_date', { ascending: true });
  if (req.query.from) query = query.gte('event_date', req.query.from);
  if (req.query.to) query = query.lte('event_date', req.query.to);
  if (req.query.status) query = query.eq('status', req.query.status);
  const { data, error } = await query;
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route GET /api/businesses/:businessId/hotel/events/:eventId
const getEvent = asyncHandler(async (req, res) => {
  const { data: event, error } = await req.supabase
    .from('hotel_events')
    .select('*, hotel_event_spaces(name, capacity)')
    .eq('id', req.params.eventId)
    .eq('business_id', req.params.businessId)
    .single();
  if (error || !event) return res.status(404).json({ message: 'Event not found' });

  const { data: charges } = await req.supabase.from('hotel_event_charges').select('*').eq('event_id', event.id).order('created_at');
  const balance = (charges || []).reduce((sum, c) => sum + Number(c.amount_aed), 0);
  res.json({ ...event, charges: charges || [], balance });
});

// @route POST /api/businesses/:businessId/hotel/events
const createEvent = asyncHandler(async (req, res) => {
  const {
    eventSpaceId = null, clientName, clientPhone = '', clientEmail = '', eventType = 'other',
    eventDate, startTime, endTime, expectedAttendance = 0, status = 'inquiry', salesNotes = '',
  } = req.body;
  if (!clientName || !eventDate || !startTime || !endTime) {
    return res.status(400).json({ message: 'clientName, eventDate, startTime, and endTime are required' });
  }
  if (endTime <= startTime) return res.status(400).json({ message: 'endTime must be after startTime' });

  if (['tentative', 'confirmed'].includes(status) && await hasEventOverlap(req.supabase, req.params.businessId, eventSpaceId, eventDate, startTime, endTime)) {
    return res.status(409).json({ message: 'This event space is already booked for an overlapping time on this date' });
  }

  const { data, error } = await req.supabase
    .from('hotel_events')
    .insert({
      business_id: req.params.businessId, event_space_id: eventSpaceId, client_name: clientName, client_phone: clientPhone,
      client_email: clientEmail, event_type: eventType, event_date: eventDate, start_time: startTime, end_time: endTime,
      expected_attendance: expectedAttendance, status, sales_notes: salesNotes, created_by: req.user.id,
    })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  await logAction({ businessId: req.params.businessId, actor: req.user, action: 'event_created', targetId: data.id, details: { clientName, eventDate, status } });
  res.status(201).json(data);
});

// @route PATCH /api/businesses/:businessId/hotel/events/:eventId
// Body: { status?, eventSpaceId?, eventDate?, startTime?, endTime?, expectedAttendance?, salesNotes? }
// Moving INTO tentative/confirmed re-checks the space for conflicts -
// moving out of them (e.g. to cancelled) never needs to, since freeing
// up a space can't create a new conflict.
const updateEvent = asyncHandler(async (req, res) => {
  const { status, eventSpaceId, eventDate, startTime, endTime, expectedAttendance, salesNotes } = req.body;

  const { data: existing } = await req.supabase.from('hotel_events').select('*').eq('id', req.params.eventId).eq('business_id', req.params.businessId).single();
  if (!existing) return res.status(404).json({ message: 'Event not found' });

  const finalSpaceId = eventSpaceId !== undefined ? eventSpaceId : existing.event_space_id;
  const finalDate = eventDate || existing.event_date;
  const finalStart = startTime || existing.start_time;
  const finalEnd = endTime || existing.end_time;
  const finalStatus = status || existing.status;

  if (['tentative', 'confirmed'].includes(finalStatus) && (eventSpaceId !== undefined || eventDate || startTime || endTime || status)) {
    if (await hasEventOverlap(req.supabase, req.params.businessId, finalSpaceId, finalDate, finalStart, finalEnd, existing.id)) {
      return res.status(409).json({ message: 'This event space is already booked for an overlapping time on this date' });
    }
  }

  const update = {};
  if (status !== undefined) update.status = status;
  if (eventSpaceId !== undefined) update.event_space_id = eventSpaceId;
  if (eventDate !== undefined) update.event_date = eventDate;
  if (startTime !== undefined) update.start_time = startTime;
  if (endTime !== undefined) update.end_time = endTime;
  if (expectedAttendance !== undefined) update.expected_attendance = expectedAttendance;
  if (salesNotes !== undefined) update.sales_notes = salesNotes;

  const { data, error } = await req.supabase
    .from('hotel_events')
    .update(update)
    .eq('id', req.params.eventId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  if (status && status !== existing.status) {
    await logAction({ businessId: req.params.businessId, actor: req.user, action: 'event_status_changed', targetId: data.id, details: { from: existing.status, to: status } });
  }
  res.json(data);
});

// --- Event billing (same ledger pattern as hotel folios) ---

const addEventCharge = asyncHandler(async (req, res) => {
  const { description, amountAed, chargeType = 'other' } = req.body;
  if (!description || amountAed == null) return res.status(400).json({ message: 'description and amountAed are required' });
  const { data: event } = await req.supabase.from('hotel_events').select('id').eq('id', req.params.eventId).eq('business_id', req.params.businessId).maybeSingle();
  if (!event) return res.status(404).json({ message: 'Event not found' });

  const { data, error } = await req.supabase
    .from('hotel_event_charges')
    .insert({ event_id: req.params.eventId, description, amount_aed: amountAed, charge_type: chargeType })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

const recordEventPayment = asyncHandler(async (req, res) => {
  const { amountAed, description = 'Payment' } = req.body;
  if (!amountAed || amountAed <= 0) return res.status(400).json({ message: 'amountAed must be a positive number' });
  const { data: event } = await req.supabase.from('hotel_events').select('id').eq('id', req.params.eventId).eq('business_id', req.params.businessId).maybeSingle();
  if (!event) return res.status(404).json({ message: 'Event not found' });

  const { data, error } = await req.supabase
    .from('hotel_event_charges')
    .insert({ event_id: req.params.eventId, description, amount_aed: -Math.abs(amountAed), charge_type: 'payment' })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

const deleteEventCharge = asyncHandler(async (req, res) => {
  const { error, count } = await req.supabase
    .from('hotel_event_charges')
    .delete({ count: 'exact' })
    .eq('id', req.params.chargeId)
    .eq('event_id', req.params.eventId);
  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Charge not found' });
  res.json({ message: 'Charge deleted' });
});

// @route GET /api/businesses/:businessId/hotel/events-pipeline-summary?from=&to=
// The actual "sales" half of sales & events - inquiries vs confirmed vs
// cancelled, and what's already been billed, for a period. Not a
// projection or forecast, just a real count of where the pipeline
// stands right now.
const getPipelineSummary = asyncHandler(async (req, res) => {
  const from = req.query.from || new Date().toISOString().slice(0, 10);
  const to = req.query.to || new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);

  const { data: events } = await req.supabase
    .from('hotel_events')
    .select('id, status, event_date')
    .eq('business_id', req.params.businessId)
    .gte('event_date', from)
    .lte('event_date', to);

  const byStatus = {};
  for (const e of events || []) byStatus[e.status] = (byStatus[e.status] || 0) + 1;

  const confirmedIds = (events || []).filter((e) => ['confirmed', 'completed'].includes(e.status)).map((e) => e.id);
  let totalBilledAed = 0;
  if (confirmedIds.length > 0) {
    const { data: charges } = await req.supabase.from('hotel_event_charges').select('event_id, amount_aed').in('event_id', confirmedIds).neq('charge_type', 'payment');
    totalBilledAed = (charges || []).reduce((sum, c) => sum + Number(c.amount_aed), 0);
  }

  res.json({
    from, to,
    byStatus,
    totalEvents: (events || []).length,
    totalBilledAed: Math.round(totalBilledAed * 100) / 100,
  });
});

module.exports = {
  listEventSpaces, createEventSpace, updateEventSpace,
  listEvents, getEvent, createEvent, updateEvent,
  addEventCharge, recordEventPayment, deleteEventCharge,
  getPipelineSummary,
};

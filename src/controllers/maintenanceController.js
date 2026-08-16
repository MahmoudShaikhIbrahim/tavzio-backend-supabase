const asyncHandler = require('../utils/asyncHandler');
const { ensureCleaningTask } = require('./housekeepingController');

const listMaintenanceTickets = asyncHandler(async (req, res) => {
  let query = req.supabase.from('maintenance_tickets').select('*, hotel_rooms(room_number), profiles(name)').eq('business_id', req.params.businessId).order('created_at', { ascending: false });
  if (req.query.status) query = query.eq('status', req.query.status);
  const { data, error } = await query;
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/hotel/maintenance
// Body: { roomId?, title, description?, priority?, assignedTo?, takeRoomOutOfService?, estimatedCostAed? }
// The real fix here: a ticket for a room now genuinely takes that room
// out of the sellable inventory (status -> 'maintenance'), rather than
// existing purely as a to-do list disconnected from what check-in and
// reservations actually see. Defaults to true whenever a room is
// attached - staff can uncheck it for something cosmetic that doesn't
// need the room pulled (a squeaky door), but the safe default is "don't
// let anyone get checked into a room with an open ticket."
const createMaintenanceTicket = asyncHandler(async (req, res) => {
  const { roomId = null, title, description = '', priority = 'normal', assignedTo = null, takeRoomOutOfService = true, estimatedCostAed = null } = req.body;
  if (!title) return res.status(400).json({ message: 'title is required' });

  const willTakeOutOfService = !!roomId && takeRoomOutOfService;
  const { data, error } = await req.supabase
    .from('maintenance_tickets')
    .insert({
      business_id: req.params.businessId, room_id: roomId, title, description, priority, assigned_to: assignedTo,
      took_room_out_of_service: willTakeOutOfService, estimated_cost_aed: estimatedCostAed,
    })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  if (willTakeOutOfService) {
    // Never overwrites 'occupied' - a guest already in the room isn't
    // evicted by a maintenance ticket; the room comes out of service the
    // moment they leave (checkOut already blocks re-selling a dirty
    // room regardless). Every other status is fair game to override.
    await req.supabase.from('hotel_rooms').update({ status: 'maintenance' }).eq('id', roomId).neq('status', 'occupied');
  }

  res.status(201).json(data);
});

// @route PATCH /api/businesses/:businessId/hotel/maintenance/:ticketId
const updateMaintenanceTicket = asyncHandler(async (req, res) => {
  const { status, assignedTo, priority, actualCostAed } = req.body;

  const { data: existing } = await req.supabase.from('maintenance_tickets').select('started_at, room_id, took_room_out_of_service').eq('id', req.params.ticketId).eq('business_id', req.params.businessId).maybeSingle();
  if (!existing) return res.status(404).json({ message: 'Ticket not found' });

  const update = {};
  if (status !== undefined) {
    update.status = status;
    update.resolved_at = status === 'resolved' ? new Date().toISOString() : null;
    if (status === 'in_progress' && !existing.started_at) update.started_at = new Date().toISOString();
  }
  if (assignedTo !== undefined) update.assigned_to = assignedTo;
  if (priority !== undefined) update.priority = priority;
  if (actualCostAed !== undefined) update.actual_cost_aed = actualCostAed;

  const { data, error } = await req.supabase
    .from('maintenance_tickets')
    .update(update)
    .eq('id', req.params.ticketId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ message: 'Ticket not found' });

  // Resolving the ticket that took the room out of service puts it back
  // in play - as 'dirty', not straight to 'available', since a room that
  // just had work done in it needs a housekeeping check before it's fit
  // to sell again. Reuses the exact same auto-queue housekeeping already
  // uses for checkout, so it shows up in that same task list.
  if (status === 'resolved' && existing.took_room_out_of_service && existing.room_id) {
    await req.supabase.from('hotel_rooms').update({ status: 'dirty' }).eq('id', existing.room_id).eq('status', 'maintenance');
    await ensureCleaningTask(req.supabase, req.params.businessId, existing.room_id);
  }

  res.json(data);
});

// @route GET /api/businesses/:businessId/hotel/maintenance-performance?days=30
// Time-in-queue vs actual repair time (same split housekeeping and the
// kitchen already use), plus total cost - a manager asking "are we
// spending too much on maintenance" needs a real number, not a guess.
const getMaintenancePerformance = asyncHandler(async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const { data: tickets, error } = await req.supabase
    .from('maintenance_tickets')
    .select('created_at, started_at, resolved_at, status, priority, actual_cost_aed, estimated_cost_aed')
    .eq('business_id', req.params.businessId)
    .gte('created_at', since);
  if (error) return res.status(400).json({ message: error.message });

  const queueMins = [];
  const repairMins = [];
  let totalActualCostAed = 0;
  for (const t of tickets || []) {
    if (t.started_at) queueMins.push((new Date(t.started_at) - new Date(t.created_at)) / 60000);
    if (t.started_at && t.resolved_at) repairMins.push((new Date(t.resolved_at) - new Date(t.started_at)) / 60000);
    if (t.actual_cost_aed) totalActualCostAed += Number(t.actual_cost_aed);
  }
  const avg = (arr) => (arr.length > 0 ? Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10 : null);

  res.json({
    days,
    ticketCount: (tickets || []).length,
    resolvedCount: (tickets || []).filter((t) => t.status === 'resolved').length,
    urgentOpenCount: (tickets || []).filter((t) => t.priority === 'urgent' && t.status !== 'resolved').length,
    avgQueueTimeMins: avg(queueMins),
    avgRepairTimeMins: avg(repairMins),
    totalActualCostAed: Math.round(totalActualCostAed * 100) / 100,
  });
});

const listGuestRequests = asyncHandler(async (req, res) => {
  let query = req.supabase.from('guest_service_requests').select('*, hotel_rooms(room_number)').eq('business_id', req.params.businessId).order('created_at', { ascending: false });
  if (req.query.status) query = query.eq('status', req.query.status);
  const { data, error } = await query;
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

const updateGuestRequest = asyncHandler(async (req, res) => {
  const { status } = req.body;
  const { data, error } = await req.supabase
    .from('guest_service_requests')
    .update({ status, resolved_at: status === 'done' ? new Date().toISOString() : null })
    .eq('id', req.params.requestId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ message: 'Request not found' });
  res.json(data);
});

module.exports = { listMaintenanceTickets, createMaintenanceTicket, updateMaintenanceTicket, getMaintenancePerformance, listGuestRequests, updateGuestRequest };

const asyncHandler = require('../utils/asyncHandler');

const listMaintenanceTickets = asyncHandler(async (req, res) => {
  let query = req.supabase.from('maintenance_tickets').select('*, hotel_rooms(room_number), profiles(name)').eq('business_id', req.params.businessId).order('created_at', { ascending: false });
  if (req.query.status) query = query.eq('status', req.query.status);
  const { data, error } = await query;
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

const createMaintenanceTicket = asyncHandler(async (req, res) => {
  const { roomId = null, title, description = '', priority = 'normal', assignedTo = null } = req.body;
  if (!title) return res.status(400).json({ message: 'title is required' });
  const { data, error } = await req.supabase
    .from('maintenance_tickets')
    .insert({ business_id: req.params.businessId, room_id: roomId, title, description, priority, assigned_to: assignedTo })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

const updateMaintenanceTicket = asyncHandler(async (req, res) => {
  const { status, assignedTo, priority } = req.body;
  const update = {};
  if (status !== undefined) { update.status = status; if (status === 'resolved') update.resolved_at = new Date().toISOString(); }
  if (assignedTo !== undefined) update.assigned_to = assignedTo;
  if (priority !== undefined) update.priority = priority;

  const { data, error } = await req.supabase
    .from('maintenance_tickets')
    .update(update)
    .eq('id', req.params.ticketId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ message: 'Ticket not found' });
  res.json(data);
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

module.exports = { listMaintenanceTickets, createMaintenanceTicket, updateMaintenanceTicket, listGuestRequests, updateGuestRequest };

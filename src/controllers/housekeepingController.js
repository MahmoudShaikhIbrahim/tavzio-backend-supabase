const asyncHandler = require('../utils/asyncHandler');

const listHousekeepingTasks = asyncHandler(async (req, res) => {
  let query = req.supabase.from('housekeeping_tasks').select('*, hotel_rooms(room_number), profiles(name)').eq('business_id', req.params.businessId)
    // Urgent tasks first, then oldest-first within each priority - same
    // "the one that's been waiting longest needs eyes on it first"
    // principle the kitchen ticket queue already uses.
    .order('priority', { ascending: true }).order('created_at', { ascending: true });
  if (req.query.status) query = query.eq('status', req.query.status);
  const { data, error } = await query;
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

const createHousekeepingTask = asyncHandler(async (req, res) => {
  const { roomId, taskType = 'cleaning', assignedTo = null, notes = '', priority = 'normal' } = req.body;
  if (!roomId) return res.status(400).json({ message: 'roomId is required' });
  const { data, error } = await req.supabase
    .from('housekeeping_tasks')
    .insert({ business_id: req.params.businessId, room_id: roomId, task_type: taskType, assigned_to: assignedTo, notes, priority })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

const updateHousekeepingTask = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'in_progress', 'done'].includes(status)) return res.status(400).json({ message: 'Invalid status' });

  const { data: existing } = await req.supabase.from('housekeeping_tasks').select('started_at').eq('id', req.params.taskId).eq('business_id', req.params.businessId).maybeSingle();

  const update = { status, completed_at: status === 'done' ? new Date().toISOString() : null };
  // Only stamped the first time a task actually starts - moving back to
  // in_progress later (a correction) never overwrites the original start.
  if (status === 'in_progress' && !existing?.started_at) update.started_at = new Date().toISOString();

  const { data: task, error } = await req.supabase
    .from('housekeeping_tasks')
    .update(update)
    .eq('id', req.params.taskId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error || !task) return res.status(404).json({ message: 'Task not found' });

  if (status === 'done' && (task.task_type === 'cleaning' || task.task_type === 'deep_clean')) {
    await req.supabase.from('hotel_rooms').update({ status: 'available' }).eq('id', task.room_id).eq('status', 'dirty');
  }
  res.json(task);
});

// @route GET /api/businesses/:businessId/housekeeping/performance?days=7
// Turnover timing: time-in-queue (created -> started) and actual clean
// time (started -> done), same split the kitchen performance report
// makes - a room sitting unclaimed for an hour is a staffing problem,
// slow actual cleaning is a different one, and this is what tells them apart.
const getHousekeepingPerformance = asyncHandler(async (req, res) => {
  const days = Math.min(30, Math.max(1, Number(req.query.days) || 7));
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const { data: tasks, error } = await req.supabase
    .from('housekeeping_tasks')
    .select('created_at, started_at, completed_at, status')
    .eq('business_id', req.params.businessId)
    .gte('created_at', since);
  if (error) return res.status(400).json({ message: error.message });

  const queueMins = [];
  const cleanMins = [];
  for (const t of tasks || []) {
    if (t.started_at) queueMins.push((new Date(t.started_at) - new Date(t.created_at)) / 60000);
    if (t.started_at && t.completed_at) cleanMins.push((new Date(t.completed_at) - new Date(t.started_at)) / 60000);
  }
  const avg = (arr) => (arr.length > 0 ? Math.round((arr.reduce((s, v) => s + v, 0) / arr.length) * 10) / 10 : null);

  res.json({
    days,
    taskCount: (tasks || []).length,
    completedCount: (tasks || []).filter((t) => t.status === 'done').length,
    avgQueueTimeMins: avg(queueMins),
    avgCleanTimeMins: avg(cleanMins),
  });
});

module.exports = { listHousekeepingTasks, createHousekeepingTask, updateHousekeepingTask, getHousekeepingPerformance, ensureCleaningTask };

// The actual fix for the real gap: a room going 'dirty' (checkout, room
// transfer) used to depend entirely on someone remembering to create a
// housekeeping task by hand - nothing ever queued one automatically.
// Called from wherever a room becomes dirty, not exposed as its own
// route. Skips creating a duplicate if this room already has an open
// (pending/in_progress) cleaning task, so a rapid checkout+transfer
// sequence never queues the same room twice.
async function ensureCleaningTask(supabase, businessId, roomId) {
  if (!roomId) return;
  const { data: existing } = await supabase
    .from('housekeeping_tasks')
    .select('id')
    .eq('business_id', businessId)
    .eq('room_id', roomId)
    .eq('task_type', 'cleaning')
    .in('status', ['pending', 'in_progress'])
    .maybeSingle();
  if (existing) return;

  await supabase.from('housekeeping_tasks').insert({ business_id: businessId, room_id: roomId, task_type: 'cleaning' });
}

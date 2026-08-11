const asyncHandler = require('../utils/asyncHandler');

const listHousekeepingTasks = asyncHandler(async (req, res) => {
  let query = req.supabase.from('housekeeping_tasks').select('*, hotel_rooms(room_number), profiles(name)').eq('business_id', req.params.businessId).order('created_at', { ascending: false });
  if (req.query.status) query = query.eq('status', req.query.status);
  const { data, error } = await query;
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

const createHousekeepingTask = asyncHandler(async (req, res) => {
  const { roomId, taskType = 'cleaning', assignedTo = null, notes = '' } = req.body;
  if (!roomId) return res.status(400).json({ message: 'roomId is required' });
  const { data, error } = await req.supabase
    .from('housekeeping_tasks')
    .insert({ business_id: req.params.businessId, room_id: roomId, task_type: taskType, assigned_to: assignedTo, notes })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

const updateHousekeepingTask = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['pending', 'in_progress', 'done'].includes(status)) return res.status(400).json({ message: 'Invalid status' });

  const { data: task, error } = await req.supabase
    .from('housekeeping_tasks')
    .update({ status, completed_at: status === 'done' ? new Date().toISOString() : null })
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

module.exports = { listHousekeepingTasks, createHousekeepingTask, updateHousekeepingTask };

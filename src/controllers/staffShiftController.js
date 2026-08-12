const asyncHandler = require('../utils/asyncHandler');

// @route GET /api/businesses/:businessId/staff-shifts/mine
// The calling staff member's currently open shift, if any - drives
// whether the dashboard shows "Clock in" or "Clock out".
const getMyOpenShift = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('staff_shifts')
    .select('*')
    .eq('business_id', req.params.businessId)
    .eq('staff_id', req.user.id)
    .is('clock_out_at', null)
    .maybeSingle();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

const clockIn = asyncHandler(async (req, res) => {
  const { data: existing } = await req.supabase
    .from('staff_shifts')
    .select('id')
    .eq('business_id', req.params.businessId)
    .eq('staff_id', req.user.id)
    .is('clock_out_at', null)
    .maybeSingle();
  if (existing) return res.status(400).json({ message: 'Already clocked in' });

  const { data, error } = await req.supabase
    .from('staff_shifts')
    .insert({ business_id: req.params.businessId, staff_id: req.user.id })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

const clockOut = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('staff_shifts')
    .update({ clock_out_at: new Date().toISOString() })
    .eq('business_id', req.params.businessId)
    .eq('staff_id', req.user.id)
    .is('clock_out_at', null)
    .select()
    .single();
  if (error || !data) return res.status(400).json({ message: 'No open shift to clock out of' });
  res.json(data);
});

// @route GET /api/businesses/:businessId/staff-shifts?from=&to=
// Owner-facing report - every shift in range, with hours worked
// computed server-side so the frontend never has to.
const listShifts = asyncHandler(async (req, res) => {
  let query = req.supabase
    .from('staff_shifts')
    .select('*, profiles(name)')
    .eq('business_id', req.params.businessId)
    .order('clock_in_at', { ascending: false });
  if (req.query.from) query = query.gte('clock_in_at', req.query.from);
  if (req.query.to) query = query.lte('clock_in_at', req.query.to);

  const { data, error } = await query;
  if (error) return res.status(400).json({ message: error.message });

  const shifts = (data || []).map((s) => ({
    ...s,
    hours: s.clock_out_at ? Math.round(((new Date(s.clock_out_at) - new Date(s.clock_in_at)) / 3600000) * 100) / 100 : null,
  }));
  res.json(shifts);
});

module.exports = { getMyOpenShift, clockIn, clockOut, listShifts };

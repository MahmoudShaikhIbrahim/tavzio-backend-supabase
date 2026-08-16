const asyncHandler = require('../utils/asyncHandler');

// Shared gate - every HR endpoint requires the overall module AND its
// specific sub-feature to be on. Route-level authorize() already
// restricts these to business_owner/super_admin; this additionally
// respects "off by default until the owner turns it on", the same
// convention every other optional feature in this codebase follows.
async function requireHrFeature(req, res, subFeature) {
  const { data: business } = await req.supabase.from('businesses').select('features').eq('id', req.params.businessId).single();
  if (!business?.features?.hr?.enabled) {
    res.status(403).json({ message: 'HR is not enabled for this business - turn it on in Features first.' });
    return null;
  }
  if (subFeature && !business.features.hr[subFeature]) {
    res.status(403).json({ message: 'This HR module isn\'t enabled - turn it on in Features first.' });
    return null;
  }
  return business;
}

// --- Staff documents ---

const listStaffDocuments = asyncHandler(async (req, res) => {
  if (!(await requireHrFeature(req, res, 'documents'))) return;
  const { data, error } = await req.supabase
    .from('staff_documents')
    .select('*, profiles!staff_documents_staff_id_fkey(name)')
    .eq('business_id', req.params.businessId)
    .order('created_at', { ascending: false });
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/hr/documents
// Body: { staffId, docType, fileUrl, label, expiryDate }
// fileUrl comes from the same Supabase Storage upload flow already used
// for logos/cover images/receipt stamps - this endpoint just records the
// reference, it doesn't handle the upload itself.
const uploadStaffDocument = asyncHandler(async (req, res) => {
  if (!(await requireHrFeature(req, res, 'documents'))) return;
  const { staffId, docType, fileUrl, label = '', expiryDate = null } = req.body;
  if (!staffId || !docType || !fileUrl) {
    return res.status(400).json({ message: 'staffId, docType, and fileUrl are required' });
  }
  const { data, error } = await req.supabase
    .from('staff_documents')
    .insert({ business_id: req.params.businessId, staff_id: staffId, doc_type: docType, file_url: fileUrl, label, expiry_date: expiryDate, uploaded_by: req.user.id })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

const deleteStaffDocument = asyncHandler(async (req, res) => {
  if (!(await requireHrFeature(req, res, 'documents'))) return;
  const { error, count } = await req.supabase
    .from('staff_documents')
    .delete({ count: 'exact' })
    .eq('id', req.params.documentId)
    .eq('business_id', req.params.businessId);
  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Document not found' });
  res.json({ message: 'Document deleted' });
});

// --- Commission ---

// @route PATCH /api/businesses/:businessId/hr/commission/:staffId
// Body: { commissionType: 'percentage' | 'fixed_per_order' | null, commissionRate }
const setStaffCommission = asyncHandler(async (req, res) => {
  if (!(await requireHrFeature(req, res, 'commission'))) return;
  const { commissionType, commissionRate } = req.body;
  if (commissionType && !['percentage', 'fixed_per_order'].includes(commissionType)) {
    return res.status(400).json({ message: 'commissionType must be percentage or fixed_per_order' });
  }
  const { data, error } = await req.supabase
    .from('profiles')
    .update({ commission_type: commissionType || null, commission_rate: commissionType ? Number(commissionRate) || 0 : null })
    .eq('id', req.params.staffId)
    .eq('business_id', req.params.businessId)
    .select('id, name, commission_type, commission_rate')
    .single();
  if (error || !data) return res.status(404).json({ message: 'Staff member not found' });
  res.json(data);
});

// @route GET /api/businesses/:businessId/hr/commission-report?from=&to=
// Every completed order attributed to a staff member (placed_by_staff_id)
// in range, with that staff member's own rate applied - a real,
// calculable number straight from orders already in the system, not a
// manually maintained spreadsheet.
const getCommissionReport = asyncHandler(async (req, res) => {
  if (!(await requireHrFeature(req, res, 'commission'))) return;
  const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString();
  const to = req.query.to || new Date().toISOString();

  const { data: staff } = await req.supabase
    .from('profiles')
    .select('id, name, commission_type, commission_rate')
    .eq('business_id', req.params.businessId)
    .not('commission_type', 'is', null);

  // Staff attribution on orders is split across two columns from two
  // different eras of this codebase - placed_by_staff_id (the older
  // staff-order flow) and placed_by (POS terminal). Fetching by range
  // and resolving both client-side, rather than filtering server-side
  // on just one, is what keeps this report accurate regardless of which
  // path an order came through.
  const { data: orders } = await req.supabase
    .from('orders')
    .select('id, total, placed_by, placed_by_staff_id, created_at, status')
    .eq('business_id', req.params.businessId)
    .neq('status', 'cancelled')
    .gte('created_at', from)
    .lte('created_at', to);

  const report = (staff || []).map((s) => {
    const staffOrders = (orders || []).filter((o) => (o.placed_by || o.placed_by_staff_id) === s.id);
    const salesTotal = staffOrders.reduce((sum, o) => sum + Number(o.total), 0);
    const commission = s.commission_type === 'percentage'
      ? Math.round(salesTotal * (Number(s.commission_rate) / 100) * 100) / 100
      : Math.round(staffOrders.length * Number(s.commission_rate) * 100) / 100;
    return { staffId: s.id, name: s.name, commissionType: s.commission_type, commissionRate: s.commission_rate, orderCount: staffOrders.length, salesTotal, commission };
  });

  res.json({ from, to, report, totalCommission: report.reduce((sum, r) => sum + r.commission, 0) });
});

// --- Tip pooling ---

const listTipDistributions = asyncHandler(async (req, res) => {
  if (!(await requireHrFeature(req, res, 'tips'))) return;
  const { data, error } = await req.supabase
    .from('tip_distributions')
    .select('*, tip_distribution_shares(id, staff_id, amount_aed, profiles(name))')
    .eq('business_id', req.params.businessId)
    .order('created_at', { ascending: false });
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/hr/tip-distributions
// Body: { periodStart, periodEnd, totalAmountAed, method: 'even' | 'by_hours', staffIds }
// 'even' splits equally across the given staffIds. 'by_hours' weights
// each share by that staff member's clocked hours within the period
// (from staff_shifts, already built) - staff with zero hours in range
// get excluded automatically rather than silently getting a $0 share
// that looks like a mistake.
const createTipDistribution = asyncHandler(async (req, res) => {
  if (!(await requireHrFeature(req, res, 'tips'))) return;
  const { periodStart, periodEnd, totalAmountAed, method = 'even', staffIds } = req.body;
  if (!periodStart || !periodEnd || !totalAmountAed || !Array.isArray(staffIds) || staffIds.length === 0) {
    return res.status(400).json({ message: 'periodStart, periodEnd, totalAmountAed, and at least one staffId are required' });
  }
  if (!['even', 'by_hours'].includes(method)) {
    return res.status(400).json({ message: 'method must be even or by_hours' });
  }

  let shares;
  if (method === 'even') {
    const perPerson = Math.round((Number(totalAmountAed) / staffIds.length) * 100) / 100;
    shares = staffIds.map((staffId) => ({ staffId, amount: perPerson }));
  } else {
    const { data: shifts } = await req.supabase
      .from('staff_shifts')
      .select('staff_id, clock_in_at, clock_out_at')
      .eq('business_id', req.params.businessId)
      .in('staff_id', staffIds)
      .gte('clock_in_at', periodStart)
      .lte('clock_in_at', periodEnd)
      .not('clock_out_at', 'is', null);

    const hoursByStaff = {};
    for (const s of shifts || []) {
      const hours = (new Date(s.clock_out_at) - new Date(s.clock_in_at)) / 3600000;
      hoursByStaff[s.staff_id] = (hoursByStaff[s.staff_id] || 0) + hours;
    }
    const totalHours = Object.values(hoursByStaff).reduce((sum, h) => sum + h, 0);
    if (totalHours === 0) return res.status(400).json({ message: 'None of the selected staff clocked any hours in this period' });
    shares = Object.entries(hoursByStaff).map(([staffId, hours]) => ({
      staffId,
      amount: Math.round((Number(totalAmountAed) * (hours / totalHours)) * 100) / 100,
    }));
  }

  const { data: distribution, error: distError } = await req.supabase
    .from('tip_distributions')
    .insert({ business_id: req.params.businessId, period_start: periodStart, period_end: periodEnd, total_amount_aed: totalAmountAed, method, created_by: req.user.id })
    .select()
    .single();
  if (distError) return res.status(400).json({ message: distError.message });

  const { error: sharesError } = await req.supabase
    .from('tip_distribution_shares')
    .insert(shares.map((s) => ({ distribution_id: distribution.id, staff_id: s.staffId, amount_aed: s.amount })));
  if (sharesError) return res.status(400).json({ message: sharesError.message });

  res.status(201).json({ distribution, shares });
});

// --- Wage rate ---

// @route PATCH /api/businesses/:businessId/hr/wage/:staffId
// Body: { hourlyRateAed: number | null }
// The rate an hour of this staff member's time actually costs - the
// input both the schedule's forecast and the actual labor-cost report
// below are built on. Null clears it (excluded from cost calculations
// rather than silently treated as AED 0/hour).
const setStaffWage = asyncHandler(async (req, res) => {
  if (!(await requireHrFeature(req, res, 'laborCost'))) return;
  const { hourlyRateAed } = req.body;
  const { data, error } = await req.supabase
    .from('profiles')
    .update({ hourly_rate_aed: hourlyRateAed != null ? Number(hourlyRateAed) : null })
    .eq('id', req.params.staffId)
    .eq('business_id', req.params.businessId)
    .select('id, name, hourly_rate_aed')
    .single();
  if (error || !data) return res.status(404).json({ message: 'Staff member not found' });
  res.json(data);
});

// --- Scheduling (roster) ---

// @route GET /api/businesses/:businessId/hr/schedules?from=&to=
const listSchedules = asyncHandler(async (req, res) => {
  if (!(await requireHrFeature(req, res, 'scheduling'))) return;
  const from = req.query.from || new Date().toISOString();
  const to = req.query.to || new Date(Date.now() + 7 * 86400000).toISOString();

  const { data, error } = await req.supabase
    .from('staff_schedules')
    .select('*, profiles!staff_schedules_staff_id_fkey(name, hourly_rate_aed)')
    .eq('business_id', req.params.businessId)
    .gte('scheduled_start', from)
    .lte('scheduled_start', to)
    .order('scheduled_start');
  if (error) return res.status(400).json({ message: error.message });

  const schedules = (data || []).map((s) => {
    const hours = (new Date(s.scheduled_end) - new Date(s.scheduled_start)) / 3600000;
    const rate = s.profiles?.hourly_rate_aed;
    return {
      id: s.id,
      staffId: s.staff_id,
      staffName: s.profiles?.name || 'Unknown',
      scheduledStart: s.scheduled_start,
      scheduledEnd: s.scheduled_end,
      roleLabel: s.role_label || '',
      notes: s.notes || '',
      hours: Math.round(hours * 100) / 100,
      forecastCostAed: rate != null ? Math.round(hours * Number(rate) * 100) / 100 : null,
    };
  });

  res.json({
    schedules,
    totalHours: Math.round(schedules.reduce((sum, s) => sum + s.hours, 0) * 100) / 100,
    totalForecastCostAed: Math.round(schedules.reduce((sum, s) => sum + (s.forecastCostAed || 0), 0) * 100) / 100,
    untrackedShiftCount: schedules.filter((s) => s.forecastCostAed == null).length,
  });
});

// @route POST /api/businesses/:businessId/hr/schedules
// Body: { staffId, scheduledStart, scheduledEnd, roleLabel, notes }
const createSchedule = asyncHandler(async (req, res) => {
  if (!(await requireHrFeature(req, res, 'scheduling'))) return;
  const { staffId, scheduledStart, scheduledEnd, roleLabel = '', notes = '' } = req.body;
  if (!staffId || !scheduledStart || !scheduledEnd) {
    return res.status(400).json({ message: 'staffId, scheduledStart, and scheduledEnd are required' });
  }
  if (new Date(scheduledEnd) <= new Date(scheduledStart)) {
    return res.status(400).json({ message: 'scheduledEnd must be after scheduledStart' });
  }
  const { data, error } = await req.supabase
    .from('staff_schedules')
    .insert({ business_id: req.params.businessId, staff_id: staffId, scheduled_start: scheduledStart, scheduled_end: scheduledEnd, role_label: roleLabel, notes, created_by: req.user.id })
    .select('*, profiles!staff_schedules_staff_id_fkey(name)')
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

const updateSchedule = asyncHandler(async (req, res) => {
  if (!(await requireHrFeature(req, res, 'scheduling'))) return;
  const { scheduledStart, scheduledEnd, roleLabel, notes } = req.body;
  const patch = {};
  if (scheduledStart != null) patch.scheduled_start = scheduledStart;
  if (scheduledEnd != null) patch.scheduled_end = scheduledEnd;
  if (roleLabel != null) patch.role_label = roleLabel;
  if (notes != null) patch.notes = notes;

  const { data, error } = await req.supabase
    .from('staff_schedules')
    .update(patch)
    .eq('id', req.params.scheduleId)
    .eq('business_id', req.params.businessId)
    .select('*, profiles!staff_schedules_staff_id_fkey(name)')
    .single();
  if (error || !data) return res.status(404).json({ message: 'Scheduled shift not found' });
  res.json(data);
});

const deleteSchedule = asyncHandler(async (req, res) => {
  if (!(await requireHrFeature(req, res, 'scheduling'))) return;
  const { error, count } = await req.supabase
    .from('staff_schedules')
    .delete({ count: 'exact' })
    .eq('id', req.params.scheduleId)
    .eq('business_id', req.params.businessId);
  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Scheduled shift not found' });
  res.json({ message: 'Scheduled shift deleted' });
});

// --- Labor cost (actual, from real clock in/out) ---

// @route GET /api/businesses/:businessId/hr/labor-cost?from=&to=
// Real labor cost from actual worked hours (staff_shifts) at each staff
// member's own rate, against revenue in the same window - the labor
// equivalent of the food-cost report. A staff member with no rate set
// is excluded from the cost total (and called out separately) rather
// than silently costed as free labor. Shifts over 8 hours are flagged
// as overtime - a simple, visible threshold rather than a jurisdiction-
// specific labor-law calculation this system has no basis to assert.
const OVERTIME_THRESHOLD_HOURS = 8;
const getLaborCostReport = asyncHandler(async (req, res) => {
  if (!(await requireHrFeature(req, res, 'laborCost'))) return;
  const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString();
  const to = req.query.to || new Date().toISOString();

  const { data: shifts } = await req.supabase
    .from('staff_shifts')
    .select('staff_id, clock_in_at, clock_out_at, profiles!staff_shifts_staff_id_fkey(name, hourly_rate_aed)')
    .eq('business_id', req.params.businessId)
    .gte('clock_in_at', from)
    .lte('clock_in_at', to)
    .not('clock_out_at', 'is', null);

  const { data: orders } = await req.supabase
    .from('orders')
    .select('total, status')
    .eq('business_id', req.params.businessId)
    .neq('status', 'cancelled')
    .gte('created_at', from)
    .lte('created_at', to);
  const totalRevenueAed = (orders || []).reduce((sum, o) => sum + Number(o.total), 0);

  const byStaff = new Map();
  let totalLaborCostAed = 0;
  let untrackedHours = 0;
  let overtimeShiftCount = 0;

  for (const s of shifts || []) {
    const hours = (new Date(s.clock_out_at) - new Date(s.clock_in_at)) / 3600000;
    if (hours > OVERTIME_THRESHOLD_HOURS) overtimeShiftCount += 1;
    const rate = s.profiles?.hourly_rate_aed;
    const cost = rate != null ? hours * Number(rate) : 0;
    if (rate == null) untrackedHours += hours;
    else totalLaborCostAed += cost;

    const entry = byStaff.get(s.staff_id) || { staffId: s.staff_id, name: s.profiles?.name || 'Unknown', hours: 0, costAed: 0, hourlyRateAed: rate ?? null, overtimeShifts: 0 };
    entry.hours += hours;
    entry.costAed += cost;
    if (hours > OVERTIME_THRESHOLD_HOURS) entry.overtimeShifts += 1;
    byStaff.set(s.staff_id, entry);
  }

  const laborCostPct = totalRevenueAed > 0 ? Math.round((totalLaborCostAed / totalRevenueAed) * 1000) / 10 : null;

  res.json({
    from, to,
    totalRevenueAed: Math.round(totalRevenueAed * 100) / 100,
    totalLaborCostAed: Math.round(totalLaborCostAed * 100) / 100,
    laborCostPct,
    untrackedHours: Math.round(untrackedHours * 100) / 100,
    overtimeShiftCount,
    byStaff: Array.from(byStaff.values())
      .map((s) => ({ ...s, hours: Math.round(s.hours * 100) / 100, costAed: Math.round(s.costAed * 100) / 100 }))
      .sort((a, b) => b.costAed - a.costAed),
  });
});

module.exports = {
  listStaffDocuments, uploadStaffDocument, deleteStaffDocument,
  setStaffCommission, getCommissionReport,
  listTipDistributions, createTipDistribution,
  setStaffWage, listSchedules, createSchedule, updateSchedule, deleteSchedule,
  getLaborCostReport,
};

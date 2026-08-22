const asyncHandler = require('../utils/asyncHandler');

// Same feature-gate shape as hrController's requireHrFeature - off by
// default until the owner enables it in Features.
async function requirePayrollFeature(req, res) {
  const { data: business } = await req.supabase.from('businesses').select('features').eq('id', req.params.businessId).single();
  if (!business?.features?.payroll?.enabled) {
    res.status(403).json({ message: 'Payroll is not enabled for this business - turn it on in Features first.' });
    return null;
  }
  return business;
}

// --- Salary structures ---

// @route GET /api/businesses/:businessId/payroll/salary-structures
const listSalaryStructures = asyncHandler(async (req, res) => {
  if (!(await requirePayrollFeature(req, res))) return;
  const { data, error } = await req.supabase
    .from('salary_structures')
    .select('*, profiles!salary_structures_staff_id_fkey(name)')
    .eq('business_id', req.params.businessId)
    .is('effective_to', null)
    .order('created_at', { ascending: false });
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/payroll/salary-structures
// Body: { staffId, payType, baseAmountAed, housingAllowanceAed, transportAllowanceAed, otherAllowancesAed }
// Closes out any existing active structure for this staff member (sets
// effective_to = today) before inserting the new one, so salary history
// is preserved rather than overwritten - same reasoning as why
// hotel_rate_overrides never mutates a past rate in place.
const setSalaryStructure = asyncHandler(async (req, res) => {
  if (!(await requirePayrollFeature(req, res))) return;
  const { staffId, payType, baseAmountAed, housingAllowanceAed = 0, transportAllowanceAed = 0, otherAllowancesAed = 0 } = req.body;
  if (!staffId || !payType || baseAmountAed == null) {
    return res.status(400).json({ message: 'staffId, payType, and baseAmountAed are required' });
  }
  if (!['monthly', 'hourly', 'daily'].includes(payType)) {
    return res.status(400).json({ message: 'payType must be monthly, hourly, or daily' });
  }

  const today = new Date().toISOString().slice(0, 10);
  await req.supabase
    .from('salary_structures')
    .update({ effective_to: today })
    .eq('business_id', req.params.businessId)
    .eq('staff_id', staffId)
    .is('effective_to', null);

  const { data, error } = await req.supabase
    .from('salary_structures')
    .insert({
      business_id: req.params.businessId,
      staff_id: staffId,
      pay_type: payType,
      base_amount_aed: Number(baseAmountAed),
      housing_allowance_aed: Number(housingAllowanceAed),
      transport_allowance_aed: Number(transportAllowanceAed),
      other_allowances_aed: Number(otherAllowancesAed),
      effective_from: today,
    })
    .select('*, profiles!salary_structures_staff_id_fkey(name)')
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// --- Payroll runs ---

// @route GET /api/businesses/:businessId/payroll/runs
const listPayrollRuns = asyncHandler(async (req, res) => {
  if (!(await requirePayrollFeature(req, res))) return;
  const { data, error } = await req.supabase
    .from('payroll_runs')
    .select('*')
    .eq('business_id', req.params.businessId)
    .order('period_start', { ascending: false });
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/payroll/runs
// Body: { periodStart, periodEnd }
// Builds one payslip per active salary structure for the period, pulling
// overtime hours from staff_schedules-derived actuals (staff_shifts, the
// same real clock-in/out table hrController's labor-cost report already
// uses) rather than the planned roster, and tips from any tip_distribution
// shares that landed inside this period. Snapshots every number onto the
// payslip row itself - later salary changes never rewrite an issued run.
const OVERTIME_THRESHOLD_HOURS = 8;
const createPayrollRun = asyncHandler(async (req, res) => {
  if (!(await requirePayrollFeature(req, res))) return;
  const { periodStart, periodEnd } = req.body;
  if (!periodStart || !periodEnd) {
    return res.status(400).json({ message: 'periodStart and periodEnd are required' });
  }
  if (new Date(periodEnd) < new Date(periodStart)) {
    return res.status(400).json({ message: 'periodEnd must be on or after periodStart' });
  }

  const { data: run, error: runError } = await req.supabase
    .from('payroll_runs')
    .insert({ business_id: req.params.businessId, period_start: periodStart, period_end: periodEnd, status: 'draft' })
    .select()
    .single();
  if (runError) return res.status(400).json({ message: runError.message });

  const { data: structures } = await req.supabase
    .from('salary_structures')
    .select('*')
    .eq('business_id', req.params.businessId)
    .is('effective_to', null);

  const { data: shifts } = await req.supabase
    .from('staff_shifts')
    .select('staff_id, clock_in_at, clock_out_at')
    .eq('business_id', req.params.businessId)
    .gte('clock_in_at', periodStart)
    .lte('clock_in_at', periodEnd)
    .not('clock_out_at', 'is', null);

  const { data: tipShares } = await req.supabase
    .from('tip_distribution_shares')
    .select('staff_id, amount_aed, tip_distributions!inner(business_id, period_start, period_end)')
    .eq('tip_distributions.business_id', req.params.businessId)
    .gte('tip_distributions.period_start', periodStart)
    .lte('tip_distributions.period_end', periodEnd);

  const hoursByStaff = {};
  for (const s of shifts || []) {
    const hours = (new Date(s.clock_out_at) - new Date(s.clock_in_at)) / 3600000;
    hoursByStaff[s.staff_id] = (hoursByStaff[s.staff_id] || 0) + hours;
  }
  const tipsByStaff = {};
  for (const t of tipShares || []) {
    tipsByStaff[t.staff_id] = (tipsByStaff[t.staff_id] || 0) + Number(t.amount_aed);
  }

  const payslipRows = (structures || []).map((s) => {
    const allowances = Number(s.housing_allowance_aed) + Number(s.transport_allowance_aed) + Number(s.other_allowances_aed);
    const hours = hoursByStaff[s.staff_id] || 0;
    const overtimeHours = s.pay_type === 'hourly' ? Math.max(0, hours - OVERTIME_THRESHOLD_HOURS * 22) : 0; // rough monthly overtime baseline for hourly staff only
    const hourlyRate = s.pay_type === 'hourly' ? Number(s.base_amount_aed) : 0;
    const overtimeAmount = overtimeHours > 0 ? Math.round(overtimeHours * hourlyRate * 1.25 * 100) / 100 : 0;
    const baseForPeriod = s.pay_type === 'hourly' ? Math.round(Math.min(hours, OVERTIME_THRESHOLD_HOURS * 22) * hourlyRate * 100) / 100 : Number(s.base_amount_aed);
    const tips = Math.round((tipsByStaff[s.staff_id] || 0) * 100) / 100;
    const gross = Math.round((baseForPeriod + allowances + overtimeAmount + tips) * 100) / 100;
    return {
      payroll_run_id: run.id,
      business_id: req.params.businessId,
      staff_id: s.staff_id,
      base_amount_aed: baseForPeriod,
      allowances_aed: allowances,
      overtime_hours: Math.round(overtimeHours * 100) / 100,
      overtime_amount_aed: overtimeAmount,
      tips_amount_aed: tips,
      gross_aed: gross,
      deductions: [],
      total_deductions_aed: 0,
      net_aed: gross,
    };
  });

  let payslips = [];
  if (payslipRows.length > 0) {
    const { data: inserted, error: payslipError } = await req.supabase
      .from('payslips')
      .insert(payslipRows)
      .select('*, profiles!payslips_staff_id_fkey(name)');
    if (payslipError) return res.status(400).json({ message: payslipError.message });
    payslips = inserted;
  }

  const totalGross = payslips.reduce((sum, p) => sum + Number(p.gross_aed), 0);
  const totalNet = payslips.reduce((sum, p) => sum + Number(p.net_aed), 0);
  await req.supabase
    .from('payroll_runs')
    .update({ total_gross_aed: totalGross, total_deductions_aed: 0, total_net_aed: totalNet })
    .eq('id', run.id);

  res.status(201).json({ ...run, total_gross_aed: totalGross, total_net_aed: totalNet, payslips });
});

// @route GET /api/businesses/:businessId/payroll/runs/:runId/payslips
const listPayslipsForRun = asyncHandler(async (req, res) => {
  if (!(await requirePayrollFeature(req, res))) return;
  const { data, error } = await req.supabase
    .from('payslips')
    .select('*, profiles!payslips_staff_id_fkey(name)')
    .eq('payroll_run_id', req.params.runId)
    .eq('business_id', req.params.businessId);
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route PATCH /api/businesses/:businessId/payroll/runs/:runId/deductions/:payslipId
// Body: { deductions: [{ label, amountAed }] }
// The only edit allowed once a run exists - adjusting itemized
// deductions before approval. Recomputes net from gross - total deductions.
const setPayslipDeductions = asyncHandler(async (req, res) => {
  if (!(await requirePayrollFeature(req, res))) return;
  const { deductions } = req.body;
  if (!Array.isArray(deductions)) return res.status(400).json({ message: 'deductions must be an array' });

  const { data: run } = await req.supabase.from('payroll_runs').select('status').eq('id', req.params.runId).eq('business_id', req.params.businessId).single();
  if (!run) return res.status(404).json({ message: 'Payroll run not found' });
  if (run.status !== 'draft') return res.status(400).json({ message: 'Only draft runs can be edited' });

  const { data: payslip } = await req.supabase.from('payslips').select('gross_aed').eq('id', req.params.payslipId).eq('payroll_run_id', req.params.runId).single();
  if (!payslip) return res.status(404).json({ message: 'Payslip not found' });

  const totalDeductions = deductions.reduce((sum, d) => sum + (Number(d.amountAed) || 0), 0);
  const net = Math.round((Number(payslip.gross_aed) - totalDeductions) * 100) / 100;

  const { data, error } = await req.supabase
    .from('payslips')
    .update({ deductions, total_deductions_aed: Math.round(totalDeductions * 100) / 100, net_aed: net })
    .eq('id', req.params.payslipId)
    .select('*, profiles!payslips_staff_id_fkey(name)')
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route PATCH /api/businesses/:businessId/payroll/runs/:runId/approve
const approvePayrollRun = asyncHandler(async (req, res) => {
  if (!(await requirePayrollFeature(req, res))) return;
  const { data: run } = await req.supabase.from('payroll_runs').select('status, total_deductions_aed').eq('id', req.params.runId).eq('business_id', req.params.businessId).single();
  if (!run) return res.status(404).json({ message: 'Payroll run not found' });
  if (run.status !== 'draft') return res.status(400).json({ message: 'Only draft runs can be approved' });

  const { data: payslips } = await req.supabase.from('payslips').select('total_deductions_aed').eq('payroll_run_id', req.params.runId);
  const totalDeductions = (payslips || []).reduce((sum, p) => sum + Number(p.total_deductions_aed), 0);

  const { data, error } = await req.supabase
    .from('payroll_runs')
    .update({ status: 'approved', approved_by: req.user.id, approved_at: new Date().toISOString(), total_deductions_aed: Math.round(totalDeductions * 100) / 100 })
    .eq('id', req.params.runId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route PATCH /api/businesses/:businessId/payroll/runs/:runId/mark-paid
const markPayrollRunPaid = asyncHandler(async (req, res) => {
  if (!(await requirePayrollFeature(req, res))) return;
  const { data: run } = await req.supabase.from('payroll_runs').select('status').eq('id', req.params.runId).eq('business_id', req.params.businessId).single();
  if (!run) return res.status(404).json({ message: 'Payroll run not found' });
  if (run.status !== 'approved') return res.status(400).json({ message: 'Only approved runs can be marked paid' });

  const { data, error } = await req.supabase
    .from('payroll_runs')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', req.params.runId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/payroll/runs/:runId/wps-export
// Generates a real UAE Central Bank WPS SIF (Salary Information File) -
// the fixed-width text format banks (incl. Wio) require for salary
// transfers. Structure: one header record, one detail record per paid
// employee, one trailer record - per the CBUAE WPS SIF v4.x spec.
// staff IBAN/Emirates ID/labour card number must be on the profile
// (added as optional columns via 0080_wps_payroll_fields.sql) - any
// staff member missing them is excluded and reported back rather than
// silently producing an invalid file the bank will reject wholesale.
function sifField(value, length, padChar = ' ', padLeft = false) {
  const str = String(value ?? '').slice(0, length);
  return padLeft ? str.padStart(length, padChar) : str.padEnd(length, padChar);
}

function buildWpsSifFile({ business, run, payslips }) {
  const missing = payslips.filter((p) => !p.profiles?.iban || !p.profiles?.labour_card_no);
  const valid = payslips.filter((p) => p.profiles?.iban && p.profiles?.labour_card_no);

  const payDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const totalAmount = valid.reduce((sum, p) => sum + Number(p.net_aed), 0);

  // Header record (Record Type 'EDR'): employer establishment ID (MOL
  // number), employer bank routing code, file creation date, currency,
  // total record count, total salary amount.
  const header = [
    'EDR',
    sifField(business.mol_establishment_id || '', 12),
    sifField(business.wps_routing_code || '', 9),
    payDate,
    'AED',
    sifField(valid.length, 6, '0', true),
    sifField(totalAmount.toFixed(2), 15, '0', true),
  ].join(',');

  // One detail record (Record Type 'SCR') per employee: labour card
  // number (unique WPS employee identifier), employee name, IBAN,
  // fixed salary components, net amount, days worked in period.
  const daysInPeriod = Math.round((new Date(run.period_end) - new Date(run.period_start)) / 86400000) + 1;
  const details = valid.map((p) => [
    'SCR',
    sifField(p.profiles.labour_card_no, 12),
    sifField(p.profiles.name, 40),
    sifField(p.profiles.iban, 23),
    sifField(Number(p.base_amount_aed).toFixed(2), 15, '0', true),
    sifField(Number(p.allowances_aed + Number(p.overtime_amount_aed) + Number(p.tips_amount_aed)).toFixed(2), 15, '0', true),
    sifField(Number(p.total_deductions_aed).toFixed(2), 15, '0', true),
    sifField(Number(p.net_aed).toFixed(2), 15, '0', true),
    sifField(daysInPeriod, 3, '0', true),
  ].join(','));

  const trailer = ['EOF', sifField(valid.length + 2, 6, '0', true)].join(',');

  return { content: [header, ...details, trailer].join('\r\n'), missing, includedCount: valid.length };
}

const recordWpsExport = asyncHandler(async (req, res) => {
  if (!(await requirePayrollFeature(req, res))) return;
  const { data: run } = await req.supabase.from('payroll_runs').select('*').eq('id', req.params.runId).eq('business_id', req.params.businessId).single();
  if (!run) return res.status(404).json({ message: 'Payroll run not found' });
  if (!['approved', 'paid'].includes(run.status)) return res.status(400).json({ message: 'Payroll run must be approved before a WPS file can be generated' });

  const { data: business } = await req.supabase.from('businesses').select('mol_establishment_id, wps_routing_code').eq('id', req.params.businessId).single();
  if (!business?.mol_establishment_id || !business?.wps_routing_code) {
    return res.status(400).json({ message: 'MOL establishment ID and WPS bank routing code must be set on the business before generating a WPS file - add them under Business Profile.' });
  }

  const { data: payslips } = await req.supabase
    .from('payslips')
    .select('*, profiles!payslips_staff_id_fkey(name, iban, labour_card_no)')
    .eq('payroll_run_id', req.params.runId);

  const { content, missing, includedCount } = buildWpsSifFile({ business, run, payslips: payslips || [] });
  if (includedCount === 0) {
    return res.status(400).json({ message: 'No staff on this run have both an IBAN and labour card number on file - nothing to export.' });
  }

  const { data, error } = await req.supabase
    .from('wps_exports')
    .insert({ payroll_run_id: req.params.runId, business_id: req.params.businessId, generated_by: req.user.id })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  res.status(201).json({
    ...data,
    sifContent: content,
    includedCount,
    excludedStaff: missing.map((p) => ({ staffId: p.staff_id, name: p.profiles?.name, missingIban: !p.profiles?.iban, missingLabourCard: !p.profiles?.labour_card_no })),
  });
});

// @route GET /api/businesses/:businessId/payroll/my-payslips
// No feature-gate check here deliberately - a staff member whose owner
// later disables payroll should still be able to see payslips they
// already received; the gate controls creating new ones, not viewing
// history. RLS (payslips.staff_id = auth.uid()) does the real scoping.
const listMyPayslips = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('payslips')
    .select('*, payroll_runs(period_start, period_end, status)')
    .eq('business_id', req.params.businessId)
    .eq('staff_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

module.exports = {
  listSalaryStructures, setSalaryStructure,
  listPayrollRuns, createPayrollRun, listPayslipsForRun, setPayslipDeductions,
  approvePayrollRun, markPayrollRunPaid, recordWpsExport, listMyPayslips,
};

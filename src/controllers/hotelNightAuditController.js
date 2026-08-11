const asyncHandler = require('../utils/asyncHandler');
const { logAction } = require('../utils/auditLog');

async function getBusinessDate(supabase, businessId) {
  const { data } = await supabase.from('hotel_business_date').select('current_date_value').eq('business_id', businessId).maybeSingle();
  if (data) return data.current_date_value;
  const today = new Date().toISOString().slice(0, 10);
  await supabase.from('hotel_business_date').upsert({ business_id: businessId, current_date_value: today });
  return today;
}

const getCurrentBusinessDate = asyncHandler(async (req, res) => {
  const date = await getBusinessDate(req.supabase, req.params.businessId);
  res.json({ businessDate: date });
});

const runNightAudit = asyncHandler(async (req, res) => {
  const businessDate = await getBusinessDate(req.supabase, req.params.businessId);

  const { data: existingAudit } = await req.supabase
    .from('hotel_night_audits')
    .select('id')
    .eq('business_id', req.params.businessId)
    .eq('business_date', businessDate)
    .maybeSingle();
  if (existingAudit) return res.status(400).json({ message: `Night audit for ${businessDate} has already been run` });

  const dayStart = `${businessDate}T00:00:00.000Z`;
  const dayEnd = `${businessDate}T23:59:59.999Z`;

  const { data: charges } = await req.supabase
    .from('hotel_folio_charges')
    .select('amount_aed, charge_type, folio_id, hotel_folios!inner(business_id)')
    .eq('hotel_folios.business_id', req.params.businessId)
    .gte('created_at', dayStart)
    .lte('created_at', dayEnd);

  let roomRevenue = 0, fnbRevenue = 0, otherRevenue = 0, totalPayments = 0;
  for (const c of charges || []) {
    const amt = Number(c.amount_aed);
    if (c.charge_type === 'room') roomRevenue += amt;
    else if (c.charge_type === 'fnb') fnbRevenue += amt;
    else if (c.charge_type === 'payment' || c.charge_type === 'deposit') totalPayments += Math.abs(amt);
    else if (c.charge_type !== 'refund' && c.charge_type !== 'adjustment') otherRevenue += amt;
  }

  const { count: roomsAvailable } = await req.supabase
    .from('hotel_rooms')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', req.params.businessId)
    .neq('status', 'out_of_order');

  const { count: roomsSold } = await req.supabase
    .from('hotel_reservations')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', req.params.businessId)
    .eq('status', 'checked_in');

  const { count: arrivals } = await req.supabase
    .from('hotel_reservations')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', req.params.businessId)
    .gte('actual_check_in_at', dayStart)
    .lte('actual_check_in_at', dayEnd);

  const { count: departures } = await req.supabase
    .from('hotel_reservations')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', req.params.businessId)
    .gte('actual_check_out_at', dayStart)
    .lte('actual_check_out_at', dayEnd);

  const occupancyRate = roomsAvailable > 0 ? (roomsSold / roomsAvailable) * 100 : 0;

  const { data: audit, error } = await req.supabase
    .from('hotel_night_audits')
    .insert({
      business_id: req.params.businessId,
      business_date: businessDate,
      run_by: req.user.id,
      room_revenue_aed: roomRevenue,
      fnb_revenue_aed: fnbRevenue,
      other_revenue_aed: otherRevenue,
      total_payments_aed: totalPayments,
      rooms_sold: roomsSold || 0,
      rooms_available: roomsAvailable || 0,
      occupancy_rate: occupancyRate,
      arrivals_count: arrivals || 0,
      departures_count: departures || 0,
    })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  const nextDate = new Date(businessDate);
  nextDate.setDate(nextDate.getDate() + 1);
  await req.supabase.from('hotel_business_date').upsert({ business_id: req.params.businessId, current_date_value: nextDate.toISOString().slice(0, 10) });

  await logAction({ businessId: req.params.businessId, actor: req.user, action: 'night_audit_run', targetId: audit.id, details: { businessDate, roomRevenue, fnbRevenue, occupancyRate } });
  res.status(201).json(audit);
});

const listNightAudits = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('hotel_night_audits')
    .select('*')
    .eq('business_id', req.params.businessId)
    .order('business_date', { ascending: false });
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

module.exports = { getCurrentBusinessDate, runNightAudit, listNightAudits };

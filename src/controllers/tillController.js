const asyncHandler = require('../utils/asyncHandler');

// @route POST /api/businesses/:businessId/till/open
// Body: { openingFloatAed, outletId? }
// One open till per staff member at a time - a second attempt to open
// while one is already running is rejected rather than silently letting
// two sessions overlap, which would make the eventual reconciliation
// meaningless (which session does a given cash order even belong to?).
//
// For a hotel business, outletId is required and locks this till to
// that one outlet for its whole session (confirmed decision - a till
// never spans two outlets, and a staff member covering two stations
// closes one till and opens another rather than the till itself being
// multi-outlet). A staff member with assigned_outlet_ids set can only
// open a till against one of their assigned outlets - checked here,
// not just hidden in the UI, since this is what actually keeps a beach
// attendant from ringing up a lobby sale by mistake.
const openTill = asyncHandler(async (req, res) => {
  const { openingFloatAed = 0, outletId } = req.body;

  const { data: existing } = await req.supabase
    .from('till_sessions')
    .select('id')
    .eq('staff_id', req.user.id)
    .eq('status', 'open')
    .maybeSingle();
  if (existing) return res.status(400).json({ message: 'You already have an open till - close it before opening a new one' });

  const { data: business } = await req.supabase.from('businesses').select('category').eq('id', req.params.businessId).single();
  let resolvedOutletId = null;
  if (business?.category === 'hotel') {
    if (!outletId) return res.status(400).json({ message: 'Select which outlet you\'re opening this till for' });
    const { data: outlet } = await req.supabase.from('hotel_outlets').select('id').eq('id', outletId).eq('business_id', req.params.businessId).eq('enabled', true).maybeSingle();
    if (!outlet) return res.status(404).json({ message: 'That outlet was not found or is disabled' });

    const assignedOutletIds = req.user.assigned_outlet_ids;
    if (Array.isArray(assignedOutletIds) && assignedOutletIds.length > 0 && !assignedOutletIds.includes(outletId)) {
      return res.status(403).json({ message: 'You are not assigned to that outlet' });
    }
    resolvedOutletId = outletId;
  }

  const { data, error } = await req.supabase
    .from('till_sessions')
    .insert({ business_id: req.params.businessId, staff_id: req.user.id, opening_float_aed: Number(openingFloatAed) || 0, outlet_id: resolvedOutletId })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// @route GET /api/businesses/:businessId/till/mine
// The current logged-in staff member's own open till, if any - what the
// POS terminal screen checks before letting anyone take a cash order.
const getMyOpenTill = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('till_sessions')
    .select('*')
    .eq('business_id', req.params.businessId)
    .eq('staff_id', req.user.id)
    .eq('status', 'open')
    .maybeSingle();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/till/:tillId/close
// Body: { countedCashAed, notes }
// This is the X/Z report moment - expected cash is computed fresh from
// real order data (opening float + every cash order actually taken
// during this session), never trusted from the client, then compared
// against what the staff member physically counted. The variance is
// recorded exactly as found - there's no "adjust to match" option here,
// on purpose, since papering over a shortfall defeats the entire point
// of reconciliation.
const closeTill = asyncHandler(async (req, res) => {
  const { countedCashAed, notes = '' } = req.body;
  if (countedCashAed == null) return res.status(400).json({ message: 'countedCashAed is required' });

  const { data: till } = await req.supabase
    .from('till_sessions')
    .select('*')
    .eq('id', req.params.tillId)
    .eq('business_id', req.params.businessId)
    .single();
  if (!till) return res.status(404).json({ message: 'Till session not found' });
  if (till.status === 'closed') return res.status(400).json({ message: 'This till is already closed' });
  if (till.staff_id !== req.user.id && req.user.role !== 'business_owner' && req.user.role !== 'super_admin') {
    return res.status(403).json({ message: 'Only the staff member who opened this till (or an owner) can close it' });
  }

  const { data: cashOrders } = await req.supabase
    .from('orders')
    .select('total')
    .eq('till_session_id', till.id)
    .eq('payment_method', 'cash')
    .neq('status', 'cancelled');

  const cashSalesTotal = (cashOrders || []).reduce((sum, o) => sum + Number(o.total), 0);
  const expectedCash = Number(till.opening_float_aed) + cashSalesTotal;
  const variance = Number(countedCashAed) - expectedCash;

  const { data: updated, error } = await req.supabase
    .from('till_sessions')
    .update({
      status: 'closed',
      closed_at: new Date().toISOString(),
      expected_cash_aed: expectedCash,
      counted_cash_aed: Number(countedCashAed),
      variance_aed: variance,
      notes,
    })
    .eq('id', till.id)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(updated);
});

// @route GET /api/businesses/:businessId/till
// History - every till session, most recent first. This is the "Z
// report" list an owner reviews to spot patterns (who's regularly short,
// who's regularly over).
const listTillSessions = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('till_sessions')
    .select('*, profiles(name)')
    .eq('business_id', req.params.businessId)
    .order('opened_at', { ascending: false });
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

module.exports = { openTill, getMyOpenTill, closeTill, listTillSessions };

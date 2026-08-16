const asyncHandler = require('../utils/asyncHandler');
const { logAction } = require('../utils/auditLog');

// @route GET /api/businesses/:businessId/hotel/city-ledger?status=unpaid|paid
// Real accounts receivable - every folio checked out with an unpaid
// balance billed to a company account, and whether it's been collected
// yet. Days outstanding included per entry - the actual number a
// finance person needs to know what to chase first.
const listCityLedgerEntries = asyncHandler(async (req, res) => {
  let query = req.supabase
    .from('hotel_city_ledger_entries')
    .select('*, hotel_folios(reservation_id, hotel_reservations(guest_id, hotel_guests(name)))')
    .eq('business_id', req.params.businessId)
    .order('billed_at', { ascending: false });
  if (req.query.status === 'unpaid') query = query.is('paid_at', null);
  if (req.query.status === 'paid') query = query.not('paid_at', 'is', null);

  const { data, error } = await query;
  if (error) return res.status(400).json({ message: error.message });

  const now = Date.now();
  const entries = (data || []).map((e) => ({
    id: e.id,
    folioId: e.folio_id,
    companyName: e.company_name,
    amountAed: Number(e.amount_aed),
    billedAt: e.billed_at,
    paidAt: e.paid_at,
    paymentReference: e.payment_reference,
    notes: e.notes,
    daysOutstanding: e.paid_at ? null : Math.floor((now - new Date(e.billed_at).getTime()) / 86400000),
    guestName: e.hotel_folios?.hotel_reservations?.hotel_guests?.name || null,
  }));

  res.json({
    entries,
    totalOutstandingAed: Math.round(entries.filter((e) => !e.paidAt).reduce((sum, e) => sum + e.amountAed, 0) * 100) / 100,
  });
});

// @route POST /api/businesses/:businessId/hotel/city-ledger/:entryId/settle
// Body: { paymentReference?, notes? }
// Marks a receivable collected - this is the actual money-in event for
// a company account; the folio itself was already closed at checkout,
// this is settling the invoice raised against it.
const settleCityLedgerEntry = asyncHandler(async (req, res) => {
  const { paymentReference = '', notes = '' } = req.body;
  const { data, error } = await req.supabase
    .from('hotel_city_ledger_entries')
    .update({ paid_at: new Date().toISOString(), payment_reference: paymentReference, notes })
    .eq('id', req.params.entryId)
    .eq('business_id', req.params.businessId)
    .is('paid_at', null)
    .select()
    .single();
  if (error || !data) return res.status(400).json({ message: 'Could not settle - entry not found or already settled' });

  await logAction({ businessId: req.params.businessId, actor: req.user, action: 'city_ledger_settled', targetId: data.id, details: { companyName: data.company_name, amountAed: data.amount_aed } });
  res.json(data);
});

module.exports = { listCityLedgerEntries, settleCityLedgerEntry };

const asyncHandler = require('../utils/asyncHandler');
const { supabaseAdmin } = require('../config/supabaseClient');
const { logAction } = require('../utils/auditLog');
const { decryptConfig } = require('../utils/credentialEncryption');

function getAdapter(provider) {
  if (provider === 'telr') return require('../utils/telrAdapter');
  if (provider === 'ngenius') return require('../utils/ngeniusAdapter');
  if (provider === 'ziina') return require('../utils/ziinaBillAdapter');
  return null;
}

async function getPaymentIntegration(businessId) {
  const { data } = await supabaseAdmin.from('pos_integrations').select('config').eq('business_id', businessId).eq('purpose', 'payment').eq('enabled', true).maybeSingle();
  return data?.config ? decryptConfig(data.config) : null;
}

const createFolioPaymentSession = asyncHandler(async (req, res) => {
  const { data: business } = await supabaseAdmin.from('businesses').select('id, slug, category').eq('slug', req.params.slug).eq('status', 'active').single();
  if (!business || business.category !== 'hotel') return res.status(404).json({ message: 'Not found' });

  const { data: room } = await supabaseAdmin.from('hotel_rooms').select('id').eq('id', req.params.roomId).eq('business_id', business.id).single();
  if (!room) return res.status(404).json({ message: 'Room not found' });

  const { data: reservation } = await supabaseAdmin.from('hotel_reservations').select('id').eq('room_id', room.id).eq('status', 'checked_in').maybeSingle();
  if (!reservation) return res.status(404).json({ message: 'No active stay in this room' });

  const { data: folio } = await supabaseAdmin.from('hotel_folios').select('id').eq('reservation_id', reservation.id).eq('is_primary', true).eq('status', 'open').maybeSingle();
  if (!folio) return res.status(404).json({ message: 'No open folio for this stay' });

  const { data: charges } = await supabaseAdmin.from('hotel_folio_charges').select('amount_aed').eq('folio_id', folio.id);
  const balance = (charges || []).reduce((sum, c) => sum + Number(c.amount_aed), 0);
  const amountAed = req.body.amountAed || balance;
  if (amountAed <= 0) return res.status(400).json({ message: 'Nothing owing on this folio' });

  const config = await getPaymentIntegration(business.id);
  const provider = config?.provider;
  const adapter = getAdapter(provider);
  if (!config || !adapter) return res.status(400).json({ message: 'This hotel has not connected a payment provider yet' });

  const { data: txn, error: txnError } = await supabaseAdmin
    .from('payment_transactions')
    .insert({ business_id: business.id, provider, transaction_type: 'charge', amount_aed: amountAed, context_type: 'hotel_folio_charge', context_id: folio.id })
    .select()
    .single();
  if (txnError) return res.status(400).json({ message: txnError.message });

  const appUrl = process.env.CLIENT_URL || '';
  const returnUrl = `${appUrl}/${business.slug}/room/${room.id}?folioPaymentTxnId=${txn.id}`;
  const session = await adapter.createPaymentSession(config, amountAed, `Room folio payment`, txn.id, returnUrl);

  if (!session.success) {
    await supabaseAdmin.from('payment_transactions').update({ status: 'failed', failure_reason: session.error }).eq('id', txn.id);
    return res.status(400).json({ message: session.error });
  }

  await supabaseAdmin.from('payment_transactions').update({ provider_ref: session.providerRef || session.chargeId || '' }).eq('id', txn.id);
  res.json({ redirectUrl: session.redirectUrl, checkoutData: session.checkoutData || null, transactionId: txn.id });
});

const confirmFolioPayment = asyncHandler(async (req, res) => {
  const { transactionId } = req.body;
  if (!transactionId) return res.status(400).json({ message: 'transactionId is required' });

  const { data: txn } = await supabaseAdmin.from('payment_transactions').select('*').eq('id', transactionId).single();
  if (!txn) return res.status(404).json({ message: 'Transaction not found' });
  if (txn.status === 'completed') return res.json({ status: 'completed' });
  if (txn.status === 'failed') return res.status(402).json({ message: txn.failure_reason || 'Payment failed', status: 'failed' });

  const config = await getPaymentIntegration(txn.business_id);
  const adapter = getAdapter(txn.provider);
  const result = await adapter.checkPaymentStatus(config, txn.provider_ref);

  if (!result.success || !result.paid) {
    await supabaseAdmin.from('payment_transactions').update({ status: 'failed', failure_reason: result.error || 'Not confirmed as paid' }).eq('id', txn.id);
    return res.status(402).json({ message: result.error || 'Payment not confirmed', status: 'failed' });
  }

  await supabaseAdmin.from('payment_transactions').update({ status: 'completed', confirmed_at: new Date().toISOString() }).eq('id', txn.id);

  const { data: charge } = await supabaseAdmin
    .from('hotel_folio_charges')
    .insert({ folio_id: txn.context_id, description: 'Online payment', amount_aed: -Math.abs(txn.amount_aed), charge_type: 'payment', payment_transaction_id: txn.id })
    .select()
    .single();

  await logAction({ businessId: txn.business_id, actor: { id: null, role: 'guest' }, action: 'folio_payment_recorded', targetId: charge?.id, details: { transactionId, provider: txn.provider, amountAed: txn.amount_aed, viaGateway: true } });
  res.json({ status: 'completed' });
});

// @route POST /api/businesses/:businessId/payment-transactions/:txnId/refund
// Body: { amountAed?, reason? } - universal refund for anything paid
// through the payment_transactions ledger (hotel folio payments, POS
// online card charges) - the restaurant-specific /payments/:id/refund
// endpoint stays separate and untouched, this covers the new surfaces.
const refundTransaction = asyncHandler(async (req, res) => {
  const { amountAed, reason } = req.body;

  const { data: txn } = await req.supabase.from('payment_transactions').select('*').eq('id', req.params.txnId).eq('business_id', req.params.businessId).single();
  if (!txn) return res.status(404).json({ message: 'Transaction not found' });
  if (txn.status !== 'completed' || txn.transaction_type !== 'charge') return res.status(400).json({ message: 'Only a completed charge can be refunded' });

  const refundAmount = amountAed != null ? Number(amountAed) : Number(txn.amount_aed);
  if (refundAmount <= 0 || refundAmount > Number(txn.amount_aed)) return res.status(400).json({ message: 'Invalid refund amount' });

  const { data: integration } = await supabaseAdmin.from('pos_integrations').select('config').eq('business_id', req.params.businessId).eq('purpose', 'payment').maybeSingle();
  if (!integration) return res.status(404).json({ message: 'Payment integration not configured' });
  integration.config = decryptConfig(integration.config);

  const adapter = getAdapter(txn.provider);
  if (!adapter?.createRefund) return res.status(400).json({ message: `Refunds for ${txn.provider} require its own dashboard, not supported here yet` });

  const result = await adapter.createRefund(integration.config, txn.provider_ref, refundAmount);
  if (!result.success) return res.status(402).json({ message: result.error || 'Refund could not be processed' });

  const { data: refundTxn } = await supabaseAdmin
    .from('payment_transactions')
    .insert({ business_id: req.params.businessId, provider: txn.provider, transaction_type: 'refund', amount_aed: refundAmount, status: 'completed', provider_ref: result.refundId || '', context_type: txn.context_type, context_id: txn.context_id, confirmed_at: new Date().toISOString() })
    .select()
    .single();

  // A folio refund is a real ledger entry the guest/hotel can see, same
  // as any other charge - a POS order refund has nowhere equivalent to
  // post to, so the payment_transactions row above is its full record.
  if (txn.context_type === 'hotel_folio_charge') {
    await supabaseAdmin.from('hotel_folio_charges').insert({ folio_id: txn.context_id, description: `Refund - ${reason || 'no reason given'}`, amount_aed: refundAmount, charge_type: 'refund', payment_transaction_id: refundTxn?.id });
  }

  await logAction({ businessId: req.params.businessId, actor: req.user, action: txn.context_type === 'hotel_folio_charge' ? 'folio_refund_issued' : 'refund', targetId: txn.id, details: { amountAed: refundAmount, reason: reason || '' } });
  res.json({ status: 'refunded', refundTransaction: refundTxn });
});

// @route GET /api/businesses/:businessId/payment-reconciliation
// Every real gateway transaction next to whether it matches a genuine
// ledger entry - the actual point of reconciliation. A folio 'payment'
// charge with no payment_transaction_id behind it was recorded manually
// by staff (cash, or a payment taken outside Tavzio entirely), not
// gateway-verified - flagged as such rather than silently trusted.
const getReconciliation = asyncHandler(async (req, res) => {
  const { data: transactions } = await req.supabase
    .from('payment_transactions')
    .select('*')
    .eq('business_id', req.params.businessId)
    .order('created_at', { ascending: false });

  const { data: manualFolioPayments } = await req.supabase
    .from('hotel_folio_charges')
    .select('id, folio_id, description, amount_aed, charge_type, created_at')
    .in('charge_type', ['payment', 'deposit'])
    .is('payment_transaction_id', null);

  res.json({
    gatewayTransactions: transactions || [],
    unverifiedManualPayments: manualFolioPayments || [],
  });
});

module.exports = { createFolioPaymentSession, confirmFolioPayment, refundTransaction, getReconciliation };

const { supabaseAdmin } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { logAction } = require('../utils/auditLog');
const { decryptConfig } = require('../utils/credentialEncryption');

// @route POST /api/businesses/:businessId/payments/:paymentId/refund
// Body: { amount?, reason? } - amount omitted means refund the full
// original payment (amount + tip); a partial refund is just a smaller
// number. Staff or owner, per explicit decision - not customer-facing.
const refundPayment = asyncHandler(async (req, res) => {
  const { amount, reason } = req.body;

  const { data: payment } = await req.supabase
    .from('payments')
    .select('*')
    .eq('id', req.params.paymentId)
    .eq('business_id', req.params.businessId)
    .maybeSingle();
  if (!payment) return res.status(404).json({ message: 'Payment not found' });
  if (payment.status !== 'completed') return res.status(400).json({ message: 'Only completed payments can be refunded' });
  if (payment.refunded) return res.status(400).json({ message: 'This payment has already been refunded' });

  const fullAmount = Number(payment.amount) + Number(payment.tip_amount);
  const refundAmount = amount != null ? Number(amount) : fullAmount;
  if (refundAmount <= 0 || refundAmount > fullAmount) {
    return res.status(400).json({ message: 'Invalid refund amount' });
  }

  const paymentProvider = payment.provider || 'tap';

  // Manual payments (cash / card machine) can't be refunded here at
  // all - there's no gateway transaction to reverse, and no UI path to
  // this anymore either. Blocked explicitly rather than left to fall
  // through to the gateway logic below, which would incorrectly try to
  // call a real payment provider's API for a transaction that never
  // went through one.
  if (paymentProvider.startsWith('manual_')) {
    return res.status(400).json({ message: 'Manual payments cannot be refunded from here' });
  }

  // Deliberately supabaseAdmin, not req.supabase: pos_integrations for
  // purpose='payment' is RLS-locked to business_owner only (the actual
  // secret key), but refunds must work for staff too, per explicit
  // decision. This lets the backend use the credentials on staff's
  // behalf without ever returning them to the client - staff still never
  // sees the raw key, they just trigger an action that uses it internally.
  const { data: integration } = await supabaseAdmin
    .from('pos_integrations')
    .select('config')
    .eq('business_id', req.params.businessId)
    .eq('purpose', 'payment')
    .maybeSingle();
  if (!integration) return res.status(404).json({ message: 'Payment integration not configured' });
  integration.config = decryptConfig(integration.config);

  // Telr's refund/void goes through a genuinely different endpoint
  // (remote.html, not order.json) with a URL-encoded response format
  // rather than JSON - this was previously left dashboard-only because
  // that format hadn't been verified. It now has (see telrAdapter.js),
  // against real, current integration examples showing the exact
  // request/response shape. One caveat that remains genuinely
  // unverifiable from documentation alone: Telr's transaction-management
  // API may need separate enablement on the specific merchant account,
  // which would surface as a real error from the call below rather than
  // a silent failure.
  let result;
  if (paymentProvider === 'telr') {
    const { createRefund } = require('../utils/telrAdapter');
    result = await createRefund(integration.config, payment.telr_tran_ref || payment.provider_ref, refundAmount);
  } else if (paymentProvider === 'ngenius') {
    const { createRefund } = require('../utils/ngeniusAdapter');
    result = await createRefund(integration.config, payment.provider_ref, refundAmount);
  } else if (paymentProvider === 'ziina') {
    const { createRefund } = require('../utils/ziinaBillAdapter');
    result = await createRefund(integration.config, payment.provider_ref, refundAmount);
  } else {
    const { createRefund } = require('../utils/tapPaymentsAdapter');
    result = await createRefund(integration.config, payment.tap_charge_id, refundAmount, reason);
  }
  if (!result.success) {
    return res.status(402).json({ message: result.error || 'Refund could not be processed' });
  }

  const { data: updated, error } = await req.supabase
    .from('payments')
    .update({
      refunded: true,
      refund_amount: refundAmount,
      refunded_at: new Date().toISOString(),
      refunded_by: req.user.id,
      tap_refund_id: result.refundId || '',
    })
    .eq('id', payment.id)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  await logAction({
    businessId: req.params.businessId,
    actor: req.user,
    action: 'refund',
    targetId: payment.id,
    details: { amount: refundAmount, reason: reason || '' },
  });

  res.json(updated);
});

module.exports = { refundPayment };

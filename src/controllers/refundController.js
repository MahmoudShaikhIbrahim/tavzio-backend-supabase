const { supabaseAdmin } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { logAction } = require('../utils/auditLog');

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

  const { createRefund } = require('../utils/tapPaymentsAdapter');
  const result = await createRefund(integration.config, payment.tap_charge_id, refundAmount, reason);
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

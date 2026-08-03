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

  const paymentProvider = payment.provider || 'tap';

  // Manual payments (cash / card machine) never moved through a gateway
  // in the first place - there is no external transaction to reverse,
  // and no pos_integrations lookup makes sense here. This is purely a
  // local correction: un-mark the items as paid so they're owed again,
  // and record that it was undone. Any actual cash/card reversal happens
  // physically, at the till, same as it always would without this
  // system - Tavzio was never holding that money.
  if (paymentProvider.startsWith('manual_')) {
    if (refundAmount !== fullAmount) {
      return res.status(400).json({ message: 'Manual payments can only be fully undone, not partially - record a new payment for the corrected amount instead' });
    }
    const { data: updated, error } = await req.supabase
      .from('payments')
      .update({ refunded: true, refund_amount: refundAmount, refunded_at: new Date().toISOString(), refunded_by: req.user.id })
      .eq('id', payment.id)
      .select()
      .single();
    if (error) return res.status(400).json({ message: error.message });

    if (Array.isArray(payment.order_item_ids) && payment.order_item_ids.length > 0) {
      await supabaseAdmin.from('order_items').update({ paid: false }).in('id', payment.order_item_ids);

      // If the table had already auto-closed (this was the last thing
      // owed, and it's now un-done), the order those items belong to
      // would otherwise stay voided - hiding a genuinely unpaid item
      // instead of making it payable again.
      const { data: affectedItems } = await supabaseAdmin
        .from('order_items')
        .select('order_id')
        .in('id', payment.order_item_ids);
      const orderIds = [...new Set((affectedItems || []).map((i) => i.order_id))];
      if (orderIds.length > 0) {
        await supabaseAdmin.from('orders').update({ voided: false }).in('id', orderIds).eq('void_reason', 'Fully paid - auto-closed');
      }
    }

    await logAction({
      businessId: req.params.businessId,
      actor: req.user,
      action: 'manual_payment_undone',
      targetId: payment.id,
      details: { amount: refundAmount, method: paymentProvider },
    });

    return res.json(updated);
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

  // Telr alone stays dashboard-only: their refund endpoint returns an
  // unstructured non-JSON response whose format couldn't be verified,
  // and their transaction-management API needs separate enablement on
  // the merchant account - real-money code doesn't get written against
  // an unverified response format. Tap and N-Genius refunds are both
  // built on their verified APIs.
  if (paymentProvider === 'telr') {
    return res.status(400).json({
      message: "Refunds for Telr payments are done in Telr's own dashboard, not from here",
    });
  }

  let result;
  if (paymentProvider === 'ngenius') {
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

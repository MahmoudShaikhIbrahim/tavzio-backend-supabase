const asyncHandler = require('../utils/asyncHandler');
const { supabaseAdmin } = require('../config/supabaseClient');
const { constructWebhookEvent } = require('../utils/stripeAdapter');
const { sendContractSignedReceipt, sendPaymentFailedWarning, sendAccountSuspended } = require('../utils/notifications');
const { primaryClientUrl } = require('../utils/clientUrl');

async function nextReceiptNumber() {
  const year = new Date().getFullYear();
  const prefix = `TVZ-${year}-`;
  const { data } = await supabaseAdmin
    .from('receipts')
    .select('receipt_number')
    .ilike('receipt_number', `${prefix}%`)
    .order('receipt_number', { ascending: false })
    .limit(1);
  const last = data?.[0]?.receipt_number;
  const lastSeq = last ? parseInt(last.slice(prefix.length), 10) : 0;
  return `${prefix}${String((lastSeq || 0) + 1).padStart(4, '0')}`;
}

// @route POST /api/stripe/webhook
// The entire automation lives here. Every event Stripe sends about a
// subscription's lifecycle - a charge succeeding, failing, or the
// subscription itself being cancelled after repeated failures - lands
// on this one endpoint and gets turned into the matching change in
// Tavzio's own database. Nothing else in the codebase decides when to
// bill or when to suspend; Stripe is the source of truth for that.
const handleStripeWebhook = asyncHandler(async (req, res) => {
  let event;
  try {
    event = constructWebhookEvent(req.rawBody, req.headers['stripe-signature']);
  } catch (err) {
    return res.status(400).json({ message: `Webhook signature verification failed: ${err.message}` });
  }

  switch (event.type) {
    // Card saved, subscription created - link it to the contract and
    // flip the contract to active. The first invoice/charge is a
    // separate event (invoice.payment_succeeded) that follows shortly.
    case 'checkout.session.completed': {
      const session = event.data.object;
      const contractId = session.metadata?.contractId;
      if (contractId) {
        const { data: existing } = await supabaseAdmin.from('contracts').select('business_id').eq('id', contractId).maybeSingle();
        // A contract already linked to a business (the old/renewal path)
        // can go straight to 'active' - the business already exists. A
        // standalone contract stops at 'paid': onboarding is the only
        // thing allowed to promote it to 'active'.
        await supabaseAdmin
          .from('contracts')
          .update({
            status: existing?.business_id ? 'active' : 'paid',
            stripe_customer_id: session.customer,
            stripe_subscription_id: session.subscription,
          })
          .eq('id', contractId);
      }
      break;
    }

    // A charge succeeded - either the first one or a recurring renewal.
    // Auto-issue a real, already-paid Tavzio receipt and email it -
    // this is the entire "automatic billing" promise in one event.
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;
      const subscriptionId = invoice.subscription;
      const { data: contract } = await supabaseAdmin.from('contracts').select('*').eq('stripe_subscription_id', subscriptionId).maybeSingle();
      if (!contract) break;
      // Not onboarded yet - there's no business to issue a receipt
      // against or an owner to email. This installment's receipt gets
      // caught up once onboardContract links the business; every
      // subsequent one bills and receipts normally.
      if (!contract.business_id) break;

      const { data: business } = await supabaseAdmin.from('businesses').select('name, owner, status').eq('id', contract.business_id).single();
      if (!business) break;

      // Reactivate immediately if this business had been suspended for
      // non-payment and just paid successfully - the loop closes itself,
      // no manual un-suspend step needed.
      if (business.status === 'suspended') {
        await supabaseAdmin.from('businesses').update({ status: 'active' }).eq('id', contract.business_id);
      }

      const { count: alreadyIssued } = await supabaseAdmin
        .from('receipts')
        .select('id', { count: 'exact', head: true })
        .eq('contract_id', contract.id);
      const periodsPerYear = contract.payment_frequency === 'monthly' ? 12 : contract.payment_frequency === 'quarterly' ? 4 : 1;
      const installmentNumber = (alreadyIssued || 0) + 1;
      const amountAed = (invoice.amount_paid || 0) / 100;

      const { data: branding } = await supabaseAdmin.from('receipt_branding').select('*').limit(1).maybeSingle();
      const receiptNumber = await nextReceiptNumber();

      const { data: receipt } = await supabaseAdmin
        .from('receipts')
        .insert({
          business_id: contract.business_id,
          receipt_number: receiptNumber,
          receipt_type: 'monthly',
          line_items: [{ description: `Tavzio platform subscription (${contract.payment_frequency} installment, Contract ${contract.contract_number})`, amount: amountAed }],
          amount: amountAed,
          period_label: `Installment ${installmentNumber} of ${periodsPerYear} under Contract ${contract.contract_number} - paid automatically via Stripe.`,
          stamp_url: branding?.stamp_url || '',
          signature_url: branding?.signature_url || '',
          contract_id: contract.id,
          installment_number: installmentNumber,
          installment_total: periodsPerYear,
          payment_status: 'paid',
          paid_at: new Date().toISOString(),
          source: 'stripe_auto',
        })
        .select()
        .single();

      const { data: ownerUser } = await supabaseAdmin.auth.admin.getUserById(business.owner);
      if (ownerUser?.user?.email && receipt) {
        const appUrl = primaryClientUrl();
        await sendContractSignedReceipt({
          email: ownerUser.user.email,
          businessName: business.name,
          receiptNumber: receipt.receipt_number,
          amountAed,
          pdfUrl: `${appUrl}/admin/dashboard/receipts`,
        });
      }
      break;
    }

    // A charge failed - Stripe will retry automatically on its own
    // schedule (Smart Retries, configured in the Stripe Dashboard).
    // This just keeps the business owner informed while that plays out.
    case 'invoice.payment_failed': {
      const invoice = event.data.object;
      const { data: contract } = await supabaseAdmin.from('contracts').select('*').eq('stripe_subscription_id', invoice.subscription).maybeSingle();
      if (!contract) break;
      const { data: business } = await supabaseAdmin.from('businesses').select('name, owner').eq('id', contract.business_id).single();
      const { data: ownerUser } = business ? await supabaseAdmin.auth.admin.getUserById(business.owner) : { data: null };
      if (ownerUser?.user?.email) {
        await sendPaymentFailedWarning({
          email: ownerUser.user.email,
          businessName: business.name,
          attempt: invoice.attempt_count || 1,
        });
      }
      break;
    }

    // Stripe gives up after exhausting its retry schedule and cancels
    // the subscription - this is the moment access actually gets cut,
    // never before Stripe itself has genuinely given up on collecting.
    case 'customer.subscription.deleted': {
      const subscription = event.data.object;
      const { data: contract } = await supabaseAdmin.from('contracts').select('*').eq('stripe_subscription_id', subscription.id).maybeSingle();
      if (!contract) break;
      await supabaseAdmin.from('contracts').update({ status: 'terminated' }).eq('id', contract.id);
      const { data: business } = await supabaseAdmin.from('businesses').select('name, owner').eq('id', contract.business_id).single();
      if (business) {
        await supabaseAdmin.from('businesses').update({ status: 'suspended' }).eq('id', contract.business_id);
        const { data: ownerUser } = await supabaseAdmin.auth.admin.getUserById(business.owner);
        if (ownerUser?.user?.email) {
          await sendAccountSuspended({ email: ownerUser.user.email, businessName: business.name });
        }
      }
      break;
    }

    default:
      break; // every other event type is intentionally ignored
  }

  res.json({ received: true });
});

module.exports = { handleStripeWebhook };

// =========================================================================
// Stripe Billing (Subscriptions) - the actual auto-charge engine.
// STRIPE_SECRET_KEY isn't set yet (no live UAE Stripe account until the
// trade license + business bank account exist) - every function here
// degrades to a clear error rather than pretending to succeed, same
// pattern as every other payment adapter in this codebase.
//
// Deliberately using Stripe's own recurring-billing lifecycle (Checkout
// in subscription mode) rather than hand-rolling charge scheduling -
// Stripe already handles the retry schedule on a failed card ("Smart
// Retries") and fires a real webhook for every state change, so Tavzio's
// own code only needs to listen and stay in sync, not reimplement any
// of that logic itself.
// =========================================================================

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  // eslint-disable-next-line global-require
  const Stripe = require('stripe');
  return new Stripe(key, { apiVersion: '2024-06-20' });
}

// Maps Tavzio's payment_frequency to Stripe's interval + interval_count -
// Stripe has no native "quarterly", it's just month x3.
function toStripeInterval(paymentFrequency) {
  if (paymentFrequency === 'monthly') return { interval: 'month', interval_count: 1 };
  if (paymentFrequency === 'quarterly') return { interval: 'month', interval_count: 3 };
  return { interval: 'year', interval_count: 1 };
}

// Creates a Stripe Checkout Session in subscription mode - the client
// enters their card on Stripe's own hosted, PCI-compliant page. Stripe
// creates the Customer, saves the card, and starts the recurring
// subscription automatically; Tavzio never touches raw card data.
async function createSubscriptionCheckoutSession({ contract, business, successUrl, cancelUrl }) {
  const stripe = getStripe();
  if (!stripe) return { success: false, error: 'Stripe is not configured yet (STRIPE_SECRET_KEY missing)' };

  const periodsPerYear = contract.payment_frequency === 'monthly' ? 12 : contract.payment_frequency === 'quarterly' ? 4 : 1;
  const perPaymentAed = contract.annual_total_aed / periodsPerYear;
  const { interval, interval_count } = toStripeInterval(contract.payment_frequency);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [
        {
          price_data: {
            currency: 'aed',
            unit_amount: Math.round(perPaymentAed * 100), // fils
            recurring: { interval, interval_count },
            product_data: {
              name: `Tavzio platform subscription - ${business.name}`,
              description: `Contract ${contract.contract_number} - ${contract.stands_count} NFC stand(s), billed ${contract.payment_frequency}`,
            },
          },
          quantity: 1,
        },
      ],
      metadata: { contractId: contract.id, businessId: business.id },
      subscription_data: { metadata: { contractId: contract.id, businessId: business.id } },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });
    return { success: true, checkoutUrl: session.url, sessionId: session.id };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function constructWebhookEvent(rawBody, signature) {
  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !webhookSecret) throw new Error('Stripe webhook is not configured yet');
  return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
}

async function cancelSubscription(subscriptionId) {
  const stripe = getStripe();
  if (!stripe) return { success: false, error: 'Stripe is not configured' };
  try {
    await stripe.subscriptions.cancel(subscriptionId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { createSubscriptionCheckoutSession, constructWebhookEvent, cancelSubscription };

const { supabaseAdmin } = require('../config/supabaseClient');
const { sendMail } = require('./notifications');

// How many months between billing events, per frequency - the real
// cadence Stripe itself already bills on (see toStripeInterval in
// stripeAdapter.js), used here to independently compute a forward-
// looking date for the countdown display without needing a live Stripe
// API call just to show an estimate.
const MONTHS_PER_CYCLE = { monthly: 1, quarterly: 3, yearly: 12 };

// How many days before contract end_date to warn - explicit, real
// requirement per frequency, not one blanket number for every contract
// type.
const EXPIRY_WARNING_DAYS = { monthly: 7, quarterly: 15, yearly: 60 };

const DAY_MS = 24 * 60 * 60 * 1000;

function daysBetween(fromDate, toDate) {
  return Math.round((toDate.getTime() - fromDate.getTime()) / DAY_MS);
}

// Finds the next billing occurrence on or after `today`, walking
// forward from start_date in real fixed steps (1/3/12 months) rather
// than assuming a 30-day month - a yearly contract started on Jan 31
// should still land on Jan 31 the following year, not Jan 30 or Feb 2.
function computeNextBillingDate(contract, today = new Date()) {
  const months = MONTHS_PER_CYCLE[contract.payment_frequency] || 1;
  const start = new Date(`${contract.start_date}T00:00:00Z`);
  const cursor = new Date(start);
  while (cursor < today) {
    cursor.setUTCMonth(cursor.getUTCMonth() + months);
  }
  return cursor;
}

function toDateOnly(d) {
  return d.toISOString().slice(0, 10);
}

// Real fix for a confirmed feature request - checks every active
// contract once a day, and sends the specific, frequency-aware
// notifications requested: 3 days before the next receipt/invoice is
// due (every frequency, same 3-day window), and a warning before
// contract end_date at a threshold that depends on the contract's own
// payment_frequency (yearly/quarterly/monthly each get their own real
// lead time, not one number for all of them).
async function checkContractBillingAndExpiryNotifications() {
  const { data: contracts } = await supabaseAdmin
    .from('contracts')
    .select('id, contract_number, business_id, start_date, end_date, payment_frequency, status, next_billing_notified_for, expiry_notified_for, businesses(name)')
    .in('status', ['active', 'paid']);
  if (!contracts || contracts.length === 0) return;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const { data: admins } = await supabaseAdmin.from('profiles').select('id').eq('role', 'super_admin');
  const adminEmails = [];
  for (const admin of admins || []) {
    const { data: u } = await supabaseAdmin.auth.admin.getUserById(admin.id);
    if (u?.user?.email) adminEmails.push(u.user.email);
  }
  if (adminEmails.length === 0) return;

  for (const contract of contracts) {
    const businessName = contract.businesses?.name || 'A business';

    // Next billing, 3-day window
    const nextBilling = computeNextBillingDate(contract, today);
    const nextBillingStr = toDateOnly(nextBilling);
    const daysToBilling = daysBetween(today, nextBilling);
    if (daysToBilling >= 0 && daysToBilling <= 3 && contract.next_billing_notified_for !== nextBillingStr) {
      await sendBillingReminder({ adminEmails, businessName, contractNumber: contract.contract_number, dueDate: nextBillingStr, daysToBilling });
      await supabaseAdmin.from('contracts').update({ next_billing_notified_for: nextBillingStr }).eq('id', contract.id);
    }

    // Contract expiry, frequency-specific window
    const endDate = new Date(`${contract.end_date}T00:00:00Z`);
    const daysToExpiry = daysBetween(today, endDate);
    const threshold = EXPIRY_WARNING_DAYS[contract.payment_frequency] || 30;
    if (daysToExpiry >= 0 && daysToExpiry <= threshold && contract.expiry_notified_for !== contract.end_date) {
      await sendExpiryReminder({ adminEmails, businessName, contractNumber: contract.contract_number, endDate: contract.end_date, daysToExpiry, frequency: contract.payment_frequency });
      await supabaseAdmin.from('contracts').update({ expiry_notified_for: contract.end_date }).eq('id', contract.id);
    }
  }
}

function sendBillingReminder({ adminEmails, businessName, contractNumber, dueDate, daysToBilling }) {
  const text = `${businessName}'s next receipt/invoice (contract ${contractNumber}) is due ${daysToBilling === 0 ? 'today' : `in ${daysToBilling} day(s)`} - ${dueDate}.`;
  return Promise.all(adminEmails.map((email) => sendMail({ to: email, subject: `Upcoming invoice - ${businessName}`, text })));
}

function sendExpiryReminder({ adminEmails, businessName, contractNumber, endDate, daysToExpiry, frequency }) {
  const text = `${businessName}'s ${frequency} contract (${contractNumber}) ends ${daysToExpiry === 0 ? 'today' : `in ${daysToExpiry} day(s)`} - ${endDate}.`;
  return Promise.all(adminEmails.map((email) => sendMail({ to: email, subject: `Contract ending soon - ${businessName}`, text })));
}

module.exports = { checkContractBillingAndExpiryNotifications, computeNextBillingDate, EXPIRY_WARNING_DAYS };

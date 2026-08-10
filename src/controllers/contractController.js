const crypto = require('crypto');
const { supabaseAdmin } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { logAction } = require('../utils/auditLog');
const { sendContractSignLink } = require('../utils/notifications');
const { createSubscriptionCheckoutSession } = require('../utils/stripeAdapter');

const DEFAULT_SYSTEM_FEE = 200;
const DEFAULT_CARD_PRICE = 20;

function periodsPerYear(frequency) {
  return frequency === 'monthly' ? 12 : frequency === 'quarterly' ? 4 : 1;
}

// @route POST /api/businesses/:businessId/contracts  (super_admin only)
// Body: { startDate, years, paymentFrequency, standsCount, systemFeeOverride, cardPriceOverride }
const createContract = asyncHandler(async (req, res) => {
  const { startDate, paymentFrequency, standsCount = 0, systemFeeOverride, cardPriceOverride } = req.body;
  if (!startDate || !paymentFrequency) {
    return res.status(400).json({ message: 'startDate and paymentFrequency are required' });
  }

  const start = new Date(startDate);
  const end = new Date(start);
  end.setFullYear(end.getFullYear() + 1); // every contract is a 1-year term, regardless of payment frequency

  const systemFee = systemFeeOverride != null ? Number(systemFeeOverride) : DEFAULT_SYSTEM_FEE;
  const cardPrice = cardPriceOverride != null ? Number(cardPriceOverride) : DEFAULT_CARD_PRICE;
  const annualTotal = (systemFee + standsCount * cardPrice) * 12;

  const { data: business } = await supabaseAdmin.from('businesses').select('name').eq('id', req.params.businessId).single();
  if (!business) return res.status(404).json({ message: 'Business not found' });

  const { count } = await supabaseAdmin.from('contracts').select('id', { count: 'exact', head: true });
  const contractNumber = `TVZ-C-${start.getFullYear()}-${String((count || 0) + 1).padStart(4, '0')}`;
  const signToken = crypto.randomBytes(24).toString('hex');

  const { data: contract, error } = await supabaseAdmin
    .from('contracts')
    .insert({
      business_id: req.params.businessId,
      contract_number: contractNumber,
      start_date: start.toISOString().slice(0, 10),
      end_date: end.toISOString().slice(0, 10),
      payment_frequency: paymentFrequency,
      stands_count: standsCount,
      system_fee_aed: systemFee,
      card_price_aed: cardPrice,
      annual_total_aed: annualTotal,
      status: 'draft',
      sign_token: signToken,
      sign_token_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days to sign
      created_by: req.user.id,
    })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  res.status(201).json(contract);
});

// @route POST /api/businesses/:businessId/contracts/:contractId/send  (super_admin only)
// The "send in a minute" step - emails the owner a no-login link to
// review and sign. Requires the business to already have an owner
// account with an email on file (super_admin creates the business
// account first via the normal Create Business flow, same as today).
const sendContract = asyncHandler(async (req, res) => {
  const { data: contract } = await supabaseAdmin.from('contracts').select('*').eq('id', req.params.contractId).single();
  const { data: business } = await supabaseAdmin.from('businesses').select('name, owner').eq('id', req.params.businessId).single();
  if (!contract || !business) return res.status(404).json({ message: 'Not found' });

  const { data: ownerUser } = await supabaseAdmin.auth.admin.getUserById(business.owner);
  const email = ownerUser?.user?.email;
  if (!email) return res.status(400).json({ message: 'This business has no owner account with an email yet - create the account first' });

  const signUrl = `${process.env.CLIENT_URL}/sign/${contract.sign_token}`;
  await sendContractSignLink({ email, businessName: business.name, signUrl });

  await supabaseAdmin.from('contracts').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', contract.id);
  res.json({ message: `Sent to ${email}` });
});

const listContracts = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('contracts')
    .select('*')
    .eq('business_id', req.params.businessId)
    .order('created_at', { ascending: false });
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

function formatLongDate(d) {
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
}

// Builds the full contract text from the template, with the business's
// real details filled in. Kept as one function so the exact text a
// business signs is always reproducible from its stored parameters.
function buildContractText(contract, business) {
  const freqLabel = { monthly: 'monthly', quarterly: 'quarterly', yearly: 'annually' }[contract.payment_frequency];
  const perPayment = contract.annual_total_aed / periodsPerYear(contract.payment_frequency);

  return `TAVZIO SERVICE AGREEMENT
Contract No: ${contract.contract_number}

This Service Agreement ("Agreement") is entered into between Tavzio ("Provider") and ${business.name} ("Client"), effective from ${formatLongDate(contract.start_date)} through ${formatLongDate(contract.end_date)} ("Term").

1. SERVICES
Provider shall supply the Client with access to the Tavzio digital guest-engagement platform, including menu, ordering, loyalty, booking, and payment features as configured for the Client's account, together with ${contract.stands_count} NFC-enabled table stand(s), rented (not sold) to the Client for the duration of this Agreement.

2. TERM
This Agreement is for a fixed term of one (1) year from the Effective Date, and shall automatically renew for successive one-year terms unless either party gives written notice of non-renewal at least thirty (30) days before the end of the then-current Term.

3. FEES AND PAYMENT
The Client shall pay Provider a platform fee of AED ${contract.system_fee_aed} per month plus AED ${contract.card_price_aed} per stand per month, totaling AED ${contract.annual_total_aed.toFixed(2)} per year, payable ${freqLabel} in installments of AED ${perPayment.toFixed(2)} each. Payment is due on the date specified on each issued receipt. A payment not received within five (5) days of its due date, after two reminder notices, may result in suspension of the Client's access to the Service. Non-payment continuing for thirty (30) days shall constitute a material breach entitling Provider to terminate this Agreement without further notice and without compensation to the Client.

4. HARDWARE
The NFC stands supplied under this Agreement remain the property of Provider at all times and are rented, not sold. Upon termination or expiry of this Agreement, the Client shall return all stands to Provider in good working condition within fourteen (14) days, ordinary wear and tear excepted. The Client shall bear the cost of repair or replacement for stands lost, stolen, or damaged beyond ordinary wear and tear.

5. DATA PROTECTION
Provider processes personal data of the Client's customers (such as names and phone numbers for loyalty purposes) solely on the Client's documented instructions, as more particularly set out in the annexed Data Processing Addendum, in accordance with UAE Federal Decree-Law No. 45 of 2021 on the Protection of Personal Data.

6. LIABILITY
Provider's total liability under this Agreement, however arising, shall not exceed the fees paid by the Client in the three (3) months preceding the event giving rise to the claim. Neither party shall be liable to the other for indirect, special, or consequential loss, including loss of profits or business interruption.

7. TERMINATION
Either party may terminate this Agreement for the other's uncured material breach, upon fifteen (15) days' written notice specifying the breach, if not cured within that period. The Client may terminate for convenience upon ninety (90) days' written notice; fees already paid for the current term are non-refundable.

8. PENALTIES
Any penalty or pre-agreed compensation under this Agreement is intended as a genuine pre-estimate of loss and is subject to review by the competent court in accordance with the UAE Civil Code, which retains the right to adjust any such amount to reflect actual loss.

9. FORCE MAJEURE
Neither party shall be liable for delay or failure to perform caused by events beyond its reasonable control, including acts of God, war, civil disturbance, or internet/utility outages.

10. GOVERNING LAW AND DISPUTES
This Agreement is governed by the laws of the Emirate of Sharjah and the federal laws of the UAE as applicable therein. Any dispute arising out of or in connection with this Agreement shall first be addressed in good faith between the parties, and if unresolved, shall be referred to the competent courts of Sharjah, UAE.

11. ENTIRE AGREEMENT
This Agreement, together with its annexed Data Processing Addendum, constitutes the entire agreement between the parties regarding its subject matter.

Client: ${business.name}
Contract Reference: ${contract.contract_number}`;
}

// @route GET /api/businesses/:businessId/contracts/:contractId/preview
const previewContract = asyncHandler(async (req, res) => {
  const { data: contract } = await req.supabase.from('contracts').select('*').eq('id', req.params.contractId).single();
  const { data: business } = await req.supabase.from('businesses').select('name').eq('id', req.params.businessId).single();
  if (!contract || !business) return res.status(404).json({ message: 'Not found' });
  res.json({ text: buildContractText(contract, business) });
});

// @route GET /api/public/contracts/:token
// No login required - this is the whole point of the quick-sign flow. A
// brand-new client has no Tavzio account yet, so this can't sit behind
// the normal auth wall the way the dashboard version does.
const getPublicContractByToken = asyncHandler(async (req, res) => {
  const { data: contract } = await supabaseAdmin.from('contracts').select('*').eq('sign_token', req.params.token).maybeSingle();
  if (!contract) return res.status(404).json({ message: 'This link is invalid or has expired' });
  if (contract.sign_token_expires_at && new Date(contract.sign_token_expires_at) < new Date()) {
    return res.status(410).json({ message: 'This signing link has expired - ask Tavzio to resend it' });
  }

  const { data: business } = await supabaseAdmin.from('businesses').select('name').eq('id', contract.business_id).single();
  const isSigned = contract.status === 'signed' || contract.status === 'active';

  res.json({
    contractNumber: contract.contract_number,
    businessName: business?.name || '',
    status: contract.status,
    text: isSigned && contract.signed_snapshot_text ? contract.signed_snapshot_text : buildContractText(contract, business),
    isSigned,
    signedByName: contract.signed_by_name,
    signedAt: contract.signed_at,
  });
});

// @route POST /api/public/contracts/:token/sign
// Body: { fullName }
// The actual "under a minute" step: type your name, check the box, done.
// Immediately hands back a Stripe Checkout URL so the very next screen
// is "add your payment method" - signing and activating happen back to
// back, not as two separate follow-ups days apart.
const signPublicContract = asyncHandler(async (req, res) => {
  const { fullName } = req.body;
  if (!fullName || !fullName.trim()) return res.status(400).json({ message: 'Full name is required to sign' });

  const { data: contract } = await supabaseAdmin.from('contracts').select('*').eq('sign_token', req.params.token).maybeSingle();
  if (!contract) return res.status(404).json({ message: 'This link is invalid or has expired' });
  if (contract.sign_token_expires_at && new Date(contract.sign_token_expires_at) < new Date()) {
    return res.status(410).json({ message: 'This signing link has expired - ask Tavzio to resend it' });
  }
  if (contract.status === 'signed' || contract.status === 'active') {
    return res.status(400).json({ message: 'This contract has already been signed' });
  }

  const { data: business } = await supabaseAdmin.from('businesses').select('name').eq('id', contract.business_id).single();
  if (!business) return res.status(404).json({ message: 'Business not found' });

  const snapshotText = buildContractText(contract, business);
  const signerIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';

  const { data: updated, error } = await supabaseAdmin
    .from('contracts')
    .update({
      status: 'signed',
      signed_snapshot_text: snapshotText,
      signed_by_name: fullName.trim(),
      signed_at: new Date().toISOString(),
      signed_ip: signerIp,
    })
    .eq('id', contract.id)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  await logAction({
    businessId: contract.business_id,
    actor: { id: null, name: fullName.trim(), role: 'business_owner' },
    action: 'contract_signed',
    targetId: updated.id,
    details: { contractNumber: contract.contract_number, signedBy: fullName, via: 'public_link' },
  });

  const appUrl = process.env.CLIENT_URL || '';
  const checkout = await createSubscriptionCheckoutSession({
    contract: updated,
    business,
    successUrl: `${appUrl}/sign/${req.params.token}?activated=1`,
    cancelUrl: `${appUrl}/sign/${req.params.token}`,
  });

  res.json({ contract: updated, checkoutUrl: checkout.success ? checkout.checkoutUrl : null, checkoutError: checkout.success ? null : checkout.error });
});

// @route POST /api/businesses/:businessId/contracts/:contractId/sign  (business_owner only)
// Body: { fullName }
// The authenticated-dashboard equivalent of the public flow above - for
// a business that already has a Tavzio account and is reviewing its
// contract from Settings rather than a fresh emailed link.
// A "simple" electronic signature under UAE Federal Decree-Law No. 46 of
// 2021 - legally valid for standard commercial agreements. What makes it
// defensible isn't the button click, it's the audit trail: the exact
// text version signed is snapshotted (never re-derived from the
// contract's current values, which could change later), alongside the
// typed name, timestamp, and IP address.
const signContract = asyncHandler(async (req, res) => {
  const { fullName } = req.body;
  if (!fullName || !fullName.trim()) return res.status(400).json({ message: 'Full name is required to sign' });

  const { data: contract } = await req.supabase.from('contracts').select('*').eq('id', req.params.contractId).single();
  const { data: business } = await req.supabase.from('businesses').select('name').eq('id', req.params.businessId).single();
  if (!contract || !business) return res.status(404).json({ message: 'Not found' });
  if (contract.status === 'signed' || contract.status === 'active') {
    return res.status(400).json({ message: 'This contract has already been signed' });
  }

  const snapshotText = buildContractText(contract, business);
  const signerIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';

  const { data: updated, error } = await supabaseAdmin
    .from('contracts')
    .update({
      status: 'signed',
      signed_snapshot_text: snapshotText,
      signed_by_name: fullName.trim(),
      signed_at: new Date().toISOString(),
      signed_ip: signerIp,
    })
    .eq('id', req.params.contractId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  await logAction({
    businessId: req.params.businessId,
    actor: req.user,
    action: 'contract_signed',
    targetId: updated.id,
    details: { contractNumber: contract.contract_number, signedBy: fullName },
  });

  res.json(updated);
});

module.exports = {
  createContract, sendContract, listContracts, previewContract, signContract,
  getPublicContractByToken, signPublicContract,
  buildContractText, periodsPerYear,
};

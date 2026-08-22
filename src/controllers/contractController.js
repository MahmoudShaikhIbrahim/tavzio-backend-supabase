const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { supabaseAdmin } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { logAction } = require('../utils/auditLog');
const { sendContractSignLink } = require('../utils/notifications');
const { createSubscriptionCheckoutSession } = require('../utils/stripeAdapter');
const { calculateVatExclusive } = require('../utils/vat');
const { primaryClientUrl } = require('../utils/clientUrl');

const DEFAULT_SYSTEM_FEE = 200;
const DEFAULT_CARD_PRICE = 20;

// Kept in sync by hand with frontend/src/pages/Home.tsx's own PLANS
// constant - the two live independently (backend and marketing page
// don't share a JS module), so this comment is the only thing enforcing
// that a contract's numbers and the public pricing page never drift
// apart again the way DEFAULT_SYSTEM_FEE above already had.
const PLAN_RATES = {
  connect: { restaurant: { base: 300, perUnit: 20 }, hotel: { base: 1500, perUnit: 20 } },
  full: { restaurant: { base: 800, perUnit: 20 }, hotel: { base: 2500, perUnit: 20 } },
};
const PLAN_DESCRIPTIONS = {
  connect: 'Tavzio Connect: the core platform - ordering, payments, and guest engagement.',
  full: 'Tavzio Full: everything in Connect, plus the full operational suite - inventory, staff, forecasting, and advanced analytics.',
};

function periodsPerYear(frequency) {
  return frequency === 'monthly' ? 12 : frequency === 'quarterly' ? 4 : 1;
}

// A contract's "party" - the business it's with - either already exists
// (business_id set, the old/renewal path) or hasn't been onboarded yet,
// in which case the client's own details typed in at contract-creation
// time stand in for it. Every no-login / admin-write code path below
// goes through this instead of assuming a businesses row exists.
async function resolveContractParty(contract) {
  if (contract.business_id) {
    const { data: business } = await supabaseAdmin.from('businesses').select('name, trn').eq('id', contract.business_id).single();
    return business || { name: contract.client_business_name || 'Client', trn: null };
  }
  return { name: contract.client_business_name || 'Client', trn: null };
}

// @route POST /api/businesses/:businessId/contracts  (super_admin only)
// Body: { startDate, years, paymentFrequency, standsCount, systemFeeOverride, cardPriceOverride }
const createContract = asyncHandler(async (req, res) => {
  const { startDate, paymentFrequency, standsCount = 0, systemFeeOverride, cardPriceOverride, planType = 'connect' } = req.body;
  if (!startDate || !paymentFrequency) {
    return res.status(400).json({ message: 'startDate and paymentFrequency are required' });
  }
  if (!['connect', 'full'].includes(planType)) {
    return res.status(400).json({ message: 'planType must be connect or full' });
  }

  const start = new Date(startDate);
  const end = new Date(start);
  end.setFullYear(end.getFullYear() + 1); // every contract is a 1-year term, regardless of payment frequency

  const { data: business } = await supabaseAdmin.from('businesses').select('name, category').eq('id', req.params.businessId).single();
  if (!business) return res.status(404).json({ message: 'Business not found' });

  // Real plan-aware pricing, not the old flat fallback that had quietly
  // drifted out of sync with what the pricing page actually charges -
  // a hotel and a restaurant on the same plan pay different base fees,
  // reflecting what each unit (room vs table) actually is.
  const category = business.category === 'hotel' ? 'hotel' : 'restaurant';
  const planRates = PLAN_RATES[planType][category];
  const systemFee = systemFeeOverride != null ? Number(systemFeeOverride) : planRates.base;
  const cardPrice = cardPriceOverride != null ? Number(cardPriceOverride) : planRates.perUnit;
  const annualTotal = (systemFee + standsCount * cardPrice) * 12;

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
      plan_type: planType,
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

// @route POST /api/contracts  (super_admin only)
// Body: { clientName, clientEmail, clientBusinessName, clientCategory, startDate, paymentFrequency, standsCount, systemFeeOverride, cardPriceOverride, planType }
// The new front door for onboarding: no business account exists yet.
// Everything the client will eventually become is captured right here on
// the contract row (client_* columns) and only turns into a real
// businesses row + login when onboardContract fires, after the client
// has actually signed and paid.
const createStandaloneContract = asyncHandler(async (req, res) => {
  const {
    clientName, clientEmail, clientBusinessName, clientCategory = 'other',
    startDate, paymentFrequency, standsCount = 0, systemFeeOverride, cardPriceOverride, planType = 'connect',
  } = req.body;

  if (!clientName || !clientEmail || !clientBusinessName) {
    return res.status(400).json({ message: 'clientName, clientEmail, and clientBusinessName are required' });
  }
  if (!startDate || !paymentFrequency) {
    return res.status(400).json({ message: 'startDate and paymentFrequency are required' });
  }
  if (!['connect', 'full'].includes(planType)) {
    return res.status(400).json({ message: 'planType must be connect or full' });
  }

  const normalizedEmail = clientEmail.trim().toLowerCase();

  // The actual fix for "why is an already-onboarded business getting a
  // second contract" - a contract is now tied to a client by email
  // rather than by clicking into a specific business, so this is the one
  // place that can actually catch it: block a new contract for anyone
  // whose most recent contract with this email is already active.
  const { data: existingActive } = await supabaseAdmin
    .from('contracts')
    .select('id, contract_number')
    .eq('client_email', normalizedEmail)
    .eq('status', 'active')
    .maybeSingle();
  if (existingActive) {
    return res.status(409).json({
      message: `${clientEmail} already has an active contract (${existingActive.contract_number}). This flow is for new clients only.`,
    });
  }

  const start = new Date(startDate);
  const end = new Date(start);
  end.setFullYear(end.getFullYear() + 1);

  const category = clientCategory === 'hotel' ? 'hotel' : 'restaurant';
  const planRates = PLAN_RATES[planType][category];
  const systemFee = systemFeeOverride != null ? Number(systemFeeOverride) : planRates.base;
  const cardPrice = cardPriceOverride != null ? Number(cardPriceOverride) : planRates.perUnit;
  const annualTotal = (systemFee + standsCount * cardPrice) * 12;

  const { count } = await supabaseAdmin.from('contracts').select('id', { count: 'exact', head: true });
  const contractNumber = `TVZ-C-${start.getFullYear()}-${String((count || 0) + 1).padStart(4, '0')}`;
  const signToken = crypto.randomBytes(24).toString('hex');

  const { data: contract, error } = await supabaseAdmin
    .from('contracts')
    .insert({
      business_id: null,
      client_name: clientName.trim(),
      client_email: normalizedEmail,
      client_business_name: clientBusinessName.trim(),
      client_category: clientCategory,
      contract_number: contractNumber,
      start_date: start.toISOString().slice(0, 10),
      end_date: end.toISOString().slice(0, 10),
      payment_frequency: paymentFrequency,
      stands_count: standsCount,
      system_fee_aed: systemFee,
      card_price_aed: cardPrice,
      annual_total_aed: annualTotal,
      plan_type: planType,
      status: 'draft',
      sign_token: signToken,
      sign_token_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      created_by: req.user.id,
    })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  res.status(201).json(contract);
});

// @route GET /api/contracts  (super_admin only)
// Every contract regardless of onboarding state - the list this new
// flow's admin page reads from, since a pre-onboarding contract has no
// business to be listed under.
const listAllContracts = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('contracts')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/contracts/:contractId/onboard  (super_admin only)
// The one deliberate moment a real Tavzio account gets created for this
// client - never earlier. By the time this fires, the contract is
// already signed and (normally) paid; this provisions the login (the
// owner sets their own password via Supabase's invite email, same
// mechanism as staff/org invites elsewhere in this codebase), creates
// the business from the details captured back when the contract was
// created, and links the two together.
const onboardContract = asyncHandler(async (req, res) => {
  const { data: contract } = await supabaseAdmin.from('contracts').select('*').eq('id', req.params.contractId).single();
  if (!contract) return res.status(404).json({ message: 'Contract not found' });
  if (contract.business_id) return res.status(400).json({ message: 'This contract is already linked to a business' });
  if (!['signed', 'paid'].includes(contract.status)) {
    return res.status(400).json({ message: 'This contract must be signed before it can be onboarded' });
  }
  if (!contract.client_email || !contract.client_business_name) {
    return res.status(400).json({ message: 'This contract has no client details on file' });
  }

  // Slug derived from the business name, made unique with a numeric
  // suffix on collision - same convention as the Create Business form's
  // own slugify(), just resolved here since nobody types one in by hand
  // for a standalone contract.
  const baseSlug = contract.client_business_name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'business';
  let slug = baseSlug;
  let suffix = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data: existingSlug } = await supabaseAdmin.from('businesses').select('id').eq('slug', slug).maybeSingle();
    if (!existingSlug) break;
    suffix += 1;
    slug = `${baseSlug}-${suffix}`;
  }

  const { data: created, error: createError } = await supabaseAdmin.auth.admin.inviteUserByEmail(contract.client_email, {
    data: { name: contract.client_name, role: 'business_owner' },
  });
  if (createError) return res.status(400).json({ message: createError.message });

  const { data: business, error: businessError } = await supabaseAdmin
    .from('businesses')
    .insert({
      name: contract.client_business_name,
      slug,
      category: contract.client_category || 'other',
      owner: created.user.id,
      status: 'active',
    })
    .select()
    .single();
  if (businessError) return res.status(400).json({ message: businessError.message });

  await supabaseAdmin.from('profiles').update({ business_id: business.id, must_change_password: true }).eq('id', created.user.id);

  const { data: updatedContract, error: contractError } = await supabaseAdmin
    .from('contracts')
    .update({ business_id: business.id, status: 'active' })
    .eq('id', contract.id)
    .select()
    .single();
  if (contractError) return res.status(400).json({ message: contractError.message });

  await logAction({
    businessId: business.id,
    actor: req.user,
    action: 'contract_onboarded',
    targetId: contract.id,
    details: { contractNumber: contract.contract_number, clientEmail: contract.client_email },
  });

  res.status(201).json({ business, contract: updatedContract });
});

// @route GET /api/contracts/:contractId/preview  (super_admin only)
// Business-agnostic counterpart to previewContract below, for a
// standalone contract that has no businessId in the URL to hang off of.
const previewStandaloneContract = asyncHandler(async (req, res) => {
  const { data: contract } = await supabaseAdmin.from('contracts').select('*').eq('id', req.params.contractId).single();
  if (!contract) return res.status(404).json({ message: 'Contract not found' });
  const business = await resolveContractParty(contract);
  const { data: branding } = await supabaseAdmin.from('receipt_branding').select('*').limit(1).maybeSingle();
  res.json({ text: buildContractText(contract, business, branding) });
});

// @route POST /api/businesses/:businessId/contracts/:contractId/send  (super_admin only)
// @route POST /api/contracts/:contractId/send  (super_admin only, standalone)
// The "send in a minute" step - emails a no-login sign link. For a
// standalone contract (no business yet) this goes straight to the
// client_email captured at contract-creation time - no owner account is
// needed, or created, just to send this email.
const sendContract = asyncHandler(async (req, res) => {
  const { data: contract } = await supabaseAdmin.from('contracts').select('*').eq('id', req.params.contractId).single();
  if (!contract) return res.status(404).json({ message: 'Contract not found' });

  let email;
  let businessName;
  if (contract.business_id) {
    const { data: business } = await supabaseAdmin.from('businesses').select('name, owner').eq('id', contract.business_id).single();
    if (!business) return res.status(404).json({ message: 'Business not found' });
    const { data: ownerUser } = await supabaseAdmin.auth.admin.getUserById(business.owner);
    email = ownerUser?.user?.email;
    businessName = business.name;
  } else {
    email = contract.client_email;
    businessName = contract.client_business_name;
  }
  if (!email) return res.status(400).json({ message: 'No email on file for this contract' });

  const signUrl = `${primaryClientUrl()}/sign/${contract.sign_token}`;
  await sendContractSignLink({ email, businessName, signUrl });

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
function buildContractText(contract, business, branding) {
  const freqLabel = { monthly: 'monthly', quarterly: 'quarterly', yearly: 'annually' }[contract.payment_frequency];
  const perPayment = contract.annual_total_aed / periodsPerYear(contract.payment_frequency);
  // Contract amounts are the net/subtotal fee (standard UAE B2B
  // convention) - 5% VAT is added on top and stated explicitly, never
  // silently absorbed into the headline figure.
  const { vatAmount: annualVat, totalIncVat: annualTotalIncVat } = calculateVatExclusive(contract.annual_total_aed);
  const { totalIncVat: perPaymentIncVat } = calculateVatExclusive(perPayment);
  const planName = contract.plan_type === 'full' ? 'Tavzio Full' : 'Tavzio Connect';
  const planDescription = PLAN_DESCRIPTIONS[contract.plan_type] || PLAN_DESCRIPTIONS.connect;
  const unitNoun = contract.stands_count === 1 ? 'stand' : 'stands';
  // Only states real coverage if a policy has actually been recorded in
  // Billing Settings (provider + policy number) - never claims insurance
  // that doesn't exist yet. This is Tavzio's (Provider's) own coverage,
  // so it's sourced from the receipt_branding singleton (Tavzio's company
  // record), not from the client business being contracted with. Falls
  // back to an honest placeholder clause that still commits Provider to
  // obtaining cover, without pretending it's already in place.
  const insuranceClause = branding?.cyber_insurance_provider && branding?.cyber_insurance_policy_number
    ? `Provider maintains cyber liability insurance with ${branding.cyber_insurance_provider} (Policy No. ${branding.cyber_insurance_policy_number}) appropriate to the scale of the Service. Evidence of coverage is available to the Client upon reasonable written request.`
    : `Provider is in the process of obtaining cyber liability insurance appropriate to the scale of the Service and will provide evidence of coverage to the Client once the policy is in place.`;

  return `TAVZIO SERVICE AGREEMENT
Contract No: ${contract.contract_number}

WELCOME TO TAVZIO
Dear ${business.name},

Thank you for choosing Tavzio to power ${business.name}'s digital guest experience. This Agreement sets out, in plain terms as well as binding ones, exactly what you're getting, what it costs, and what each side commits to - so there are no surprises on either end of this relationship.

You've selected the ${planName} plan, described in full under Section 1 below. In short: ${planDescription} From the moment this Agreement is signed and your first payment clears, your account is provisioned and your NFC stands are dispatched - most businesses are live within a few working days.

A dedicated point of contact at Tavzio remains available throughout your Term for setup support, feature questions, or anything else that comes up. What follows is the formal Agreement - please read it in full before signing, and don't hesitate to ask before you do.

This Service Agreement ("Agreement") is entered into between Tavzio ("Provider") and ${business.name} ("Client"), effective from ${formatLongDate(contract.start_date)} through ${formatLongDate(contract.end_date)} ("Term").

1. SERVICES AND SELECTED PLAN
Provider shall supply the Client with access to the Tavzio digital guest-engagement platform under the ${planName} plan. ${planDescription} Services are configured for the Client's account as agreed, together with ${contract.stands_count} NFC-enabled table ${unitNoun}, rented (not sold) to the Client for the duration of this Agreement. The Client's plan may be upgraded at any time by mutual written agreement, effective from the next billing period; a downgrade takes effect at the start of the next annual Term.

2. TERM
This Agreement is for a fixed term of one (1) year from the Effective Date, and shall automatically renew for successive one-year terms unless either party gives written notice of non-renewal at least thirty (30) days before the end of the then-current Term.

3. FEES AND PAYMENT
The Client shall pay Provider a ${planName} platform fee of AED ${contract.system_fee_aed} per month plus AED ${contract.card_price_aed} per stand per month, totaling AED ${contract.annual_total_aed.toFixed(2)} per year (excluding VAT), plus 5% UAE VAT of AED ${annualVat.toFixed(2)}, for a total of AED ${annualTotalIncVat.toFixed(2)} per year inclusive of VAT, payable ${freqLabel} in installments of AED ${perPayment.toFixed(2)} each excluding VAT (AED ${perPaymentIncVat.toFixed(2)} inclusive of VAT). Payment is due on the date specified on each issued tax invoice, which will state the VAT amount separately as required under UAE Federal Decree-Law No. 8 of 2017 on Value Added Tax and its Executive Regulation. A payment not received within five (5) days of its due date, after two reminder notices, may result in suspension of the Client's access to the Service. Non-payment continuing for thirty (30) days shall constitute a material breach entitling Provider to terminate this Agreement without further notice and without compensation to the Client.

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
This Agreement, together with its annexed Data Processing Addendum (Annex A) and Refund Policy (Annex B), and the Tavzio Terms of Service and Privacy Policy published at tavzio.ae/legal, constitutes the entire agreement between the parties regarding its subject matter. In the event of conflict, this Agreement and its Annexes take precedence over the Terms of Service and Privacy Policy for matters they both address.

12. INSURANCE
${insuranceClause}

Client: ${business.name}
Contract Reference: ${contract.contract_number}

---

ANNEX A: DATA PROCESSING ADDENDUM

This Data Processing Addendum ("DPA") forms part of and is incorporated into the Agreement between Provider (acting as data processor) and Client (acting as data controller) referenced above, in accordance with UAE Federal Decree-Law No. 45 of 2021 on the Protection of Personal Data.

A.1 Subject Matter. Provider processes personal data submitted to the Tavzio platform by Client - including guest/customer identity and contact details, reservation and order history, loyalty and preference data, and staff records where the relevant module is enabled - for the duration of the Agreement.

A.2 Processor Obligations. Provider shall: (a) process personal data only on Client's documented instructions; (b) ensure personnel with access to such data are bound by confidentiality obligations; (c) implement appropriate technical and organizational security measures, including encryption of sensitive credentials and tenant-level data isolation between Provider's customers; (d) assist Client in responding to data subject requests to the extent reasonably required; (e) notify Client without undue delay upon becoming aware of a personal data breach affecting Client's data; and (f) delete or return Client's personal data at the end of the Agreement, at Client's election, subject to legal retention requirements.

A.3 Subprocessors. Client authorizes Provider to engage subprocessors reasonably necessary to provide the Service, including cloud hosting and payment gateway providers. Provider remains responsible for such subprocessors' compliance with the obligations in this Annex.

A.4 International Transfers. Where personal data is transferred outside the UAE in the course of providing the Service, Provider shall apply safeguards consistent with UAE Federal Decree-Law No. 45 of 2021.

---

ANNEX B: REFUND POLICY

B.1 Subscription fees paid for a billing period that has already started are non-refundable, except as expressly provided in this Annex or as required by law.

B.2 If the Service experiences a material outage attributable to Provider lasting longer than twenty-four (24) consecutive hours within a billing period, Client may request a pro-rated credit for the affected period, applied to a future invoice. This does not apply to outages caused by third-party integrations, Client's own infrastructure, or scheduled maintenance communicated in advance.

B.3 If Client is charged in error, Provider will investigate and issue a refund or credit for the erroneous amount within fourteen (14) business days of confirming the error.

B.4 Rental fees already paid for NFC stands are non-refundable. Client may be charged a replacement fee for hardware not returned per Section 4 of this Agreement.

B.5 Refund requests should be submitted in writing to Provider's designated billing contact, referencing the invoice number and reason for the request.`;
}

// @route GET /api/businesses/:businessId/contracts/:contractId/preview
const previewContract = asyncHandler(async (req, res) => {
  const { data: contract } = await req.supabase.from('contracts').select('*').eq('id', req.params.contractId).single();
  const { data: business } = await req.supabase.from('businesses').select('name').eq('id', req.params.businessId).single();
  if (!contract || !business) return res.status(404).json({ message: 'Not found' });
  const { data: branding } = await req.supabase.from('receipt_branding').select('*').limit(1).maybeSingle();
  res.json({ text: buildContractText(contract, business, branding) });
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

  const business = await resolveContractParty(contract);
  const isSigned = ['signed', 'paid', 'active'].includes(contract.status);
  const { data: branding } = await supabaseAdmin.from('receipt_branding').select('*').limit(1).maybeSingle();

  res.json({
    contractNumber: contract.contract_number,
    businessName: business?.name || '',
    status: contract.status,
    text: isSigned && contract.signed_snapshot_text ? contract.signed_snapshot_text : buildContractText(contract, business, branding),
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
  if (['signed', 'paid', 'active'].includes(contract.status)) {
    return res.status(400).json({ message: 'This contract has already been signed' });
  }

  const business = await resolveContractParty(contract);

  const { data: branding } = await supabaseAdmin.from('receipt_branding').select('*').limit(1).maybeSingle();
  const snapshotText = buildContractText(contract, business, branding);
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

  const appUrl = primaryClientUrl();
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

  const { data: branding } = await req.supabase.from('receipt_branding').select('*').limit(1).maybeSingle();
  const snapshotText = buildContractText(contract, business, branding);
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

// @route GET /api/businesses/:businessId/contracts/:contractId/pdf
// Real downloadable, professional PDF - not just text in the browser.
// Reuses the same stamp/signature/legal-name branding row the receipts
// system already maintains (set once in Billing Settings, applied
// everywhere), so both documents carry identical, consistent branding.
// For a signed contract, the typed name + timestamp + IP captured at
// signing renders as the e-signature block - the DocuSign-style proof
// of consent, permanently part of this specific document.
const downloadContractPdf = asyncHandler(async (req, res) => {
  const { data: contract } = await req.supabase.from('contracts').select('*').eq('id', req.params.contractId).single();
  if (!contract) return res.status(404).json({ message: 'Contract not found' });
  // Authenticated dashboard route passes a real businessId in the URL
  // and expects it to match; the public/no-login route (which may be a
  // not-yet-onboarded standalone contract) skips this check entirely.
  if (req.params.businessId && contract.business_id && String(contract.business_id) !== String(req.params.businessId)) {
    return res.status(404).json({ message: 'Contract not found' });
  }

  const business = contract.business_id
    ? (await req.supabase.from('businesses').select('name, trn').eq('id', contract.business_id).single()).data
    : { name: contract.client_business_name || 'Client', trn: null };
  const { data: branding } = await req.supabase.from('receipt_branding').select('*').limit(1).maybeSingle();

  const isSigned = ['signed', 'paid', 'active'].includes(contract.status);
  const text = isSigned && contract.signed_snapshot_text ? contract.signed_snapshot_text : buildContractText(contract, business, branding);
  const legalName = branding?.legal_name || 'Tavzio';
  const brass = '#b8925a';
  const ink = '#20170f';

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${contract.contract_number}.pdf"`);

  const doc = new PDFDocument({ size: 'A4', margin: 56, bufferPages: true });
  doc.pipe(res);

  // Header - identical branding language to receipts
  doc.fontSize(22).fillColor(ink).font('Helvetica-Bold').text(legalName, { align: 'left' });
  if (branding?.issuer_trn) {
    doc.fontSize(9).fillColor('#666').font('Helvetica').text(`TRN: ${branding.issuer_trn}`, { align: 'left' });
  }
  doc.moveDown(1);
  doc.fontSize(16).fillColor(ink).font('Helvetica-Bold').text('SERVICE AGREEMENT', { align: 'right' });
  doc.fontSize(10).fillColor('#666').font('Helvetica').text(`No. ${contract.contract_number}`, { align: 'right' });
  doc.moveDown(0.8);
  doc.moveTo(56, doc.y).lineTo(539, doc.y).strokeColor(brass).lineWidth(1).stroke();
  doc.moveDown(1);

  // Body - the full agreement text, paginating naturally with PDFKit's
  // own flow rather than manual page-break math.
  doc.fontSize(10).fillColor('#222').font('Helvetica').text(text, { width: 483, align: 'left', lineGap: 3 });

  // E-signature block - only for a contract that's actually been signed.
  // This is the part that makes it a real, provable signature: not just
  // "Signed" but who, exactly when, and from where.
  if (isSigned) {
    doc.moveDown(2);
    doc.moveTo(56, doc.y).lineTo(539, doc.y).strokeColor('#ccc').lineWidth(0.5).stroke();
    doc.moveDown(0.8);
    doc.fontSize(11).fillColor(ink).font('Helvetica-Bold').text('Electronically signed');
    doc.fontSize(10).fillColor('#333').font('Helvetica')
      .text(`Signed by: ${contract.signed_by_name}`)
      .text(`Date: ${new Date(contract.signed_at).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })}`)
      .text(`IP address: ${contract.signed_ip || 'not recorded'}`);
    doc.fontSize(8.5).fillColor('#888').font('Helvetica').text(
      'This is a valid electronic signature under UAE Federal Decree-Law No. 46 of 2021 on Electronic Transactions and Trust Services. ' +
      'The signer\'s typed name, the exact agreement text above, the timestamp, and the originating IP address were captured together at the moment of signing.',
      { width: 483 }
    );
  }

  // Stamp and signature images - fixed near the bottom of the current
  // page, same placement convention as receipts.
  const stampY = Math.min(doc.y + 30, 700);
  if (branding?.signature_url) {
    try {
      const sigRes = await fetch(branding.signature_url);
      const sigBuffer = Buffer.from(await sigRes.arrayBuffer());
      doc.image(sigBuffer, 340, stampY, { width: 140 });
      doc.moveTo(340, stampY + 46).lineTo(480, stampY + 46).strokeColor('#999').lineWidth(0.5).stroke();
      doc.fontSize(9).fillColor('#666').text('Authorized signature (Tavzio)', 340, stampY + 50);
    } catch {
      // A broken signature URL should never break the whole PDF.
    }
  }
  if (branding?.stamp_url) {
    try {
      const stampRes = await fetch(branding.stamp_url);
      const stampBuffer = Buffer.from(await stampRes.arrayBuffer());
      doc.image(stampBuffer, 56, stampY - 10, { width: 110 });
    } catch {
      // Same resilience as the signature above.
    }
  }

  doc.end();
});

// @route GET /api/public/contracts/:token/pdf
// Same no-login rule as the rest of this file - the client needs to be
// able to download their own signed copy from the emailed link without
// ever having to create an account.
const downloadPublicContractPdf = asyncHandler(async (req, res) => {
  const { data: contract } = await supabaseAdmin.from('contracts').select('*').eq('sign_token', req.params.token).maybeSingle();
  if (!contract) return res.status(404).json({ message: 'This link is invalid or has expired' });
  req.params.contractId = contract.id;
  req.params.businessId = contract.business_id || undefined;
  req.supabase = supabaseAdmin; // no authenticated RLS session on the public route - service role, scoped manually above
  return downloadContractPdf(req, res);
});

module.exports = {
  createContract, sendContract, listContracts, previewContract, signContract, downloadContractPdf, downloadPublicContractPdf,
  getPublicContractByToken, signPublicContract,
  createStandaloneContract, listAllContracts, onboardContract, previewStandaloneContract,
  buildContractText, periodsPerYear,
};

const PDFDocument = require('pdfkit');
const asyncHandler = require('../utils/asyncHandler');
const { supabaseAdmin } = require('../config/supabaseClient');
const { calculateVatExclusive, calculateVatInclusive } = require('../utils/vat');

// @route GET /api/businesses/:businessId/receipts
// Business owner/staff see their own; super_admin can view any business's
// by passing its id - same access shape as every other business-scoped
// list in this app.
const listReceipts = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('receipts')
    .select('*')
    .eq('business_id', req.params.businessId)
    .eq('status', 'issued')
    .order('created_at', { ascending: false });

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// Builds the next sequential receipt number for the current year, e.g.
// TVZ-2026-0001, TVZ-2026-0002... Sequential numbering (not a random or
// per-business counter) is what makes a receipt read as a real, ordered
// financial record rather than an arbitrary document.
async function nextReceiptNumber(supabase) {
  const year = new Date().getFullYear();
  const prefix = `TVZ-${year}-`;
  const { data } = await supabase
    .from('receipts')
    .select('receipt_number')
    .ilike('receipt_number', `${prefix}%`)
    .order('receipt_number', { ascending: false })
    .limit(1);

  const last = data?.[0]?.receipt_number;
  const lastSeq = last ? parseInt(last.slice(prefix.length), 10) : 0;
  const nextSeq = (lastSeq || 0) + 1;
  return `${prefix}${String(nextSeq).padStart(4, '0')}`;
}

// @route POST /api/businesses/:businessId/receipts
// super_admin only. Body: { receiptType, lineItems: [{description, amount}], periodLabel?, notes? }
// Captures whatever stamp/signature/legal name is CURRENTLY active and
// freezes it onto this specific receipt - a later branding update will
// never alter what this receipt shows when re-downloaded.
const createReceipt = asyncHandler(async (req, res) => {
  const { receiptType, lineItems, periodLabel = '', notes = '' } = req.body;

  if (!['one_time', 'monthly', 'adjustment'].includes(receiptType)) {
    return res.status(400).json({ message: 'Invalid receipt type' });
  }
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return res.status(400).json({ message: 'At least one line item is required' });
  }

  // line_items stay net (excl. VAT) - that's what the itemized table on
  // the PDF shows, exactly like a standard tax invoice. `amount` is what
  // this receipt actually charges: the real VAT-inclusive total, since
  // that's also what gets sent to Ziina below - VAT must genuinely be
  // collected under UAE Federal Decree-Law No. 8 of 2017, not just
  // shown on paper while the real charge stays net.
  const netAmount = lineItems.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const amount = calculateVatExclusive(netAmount).totalIncVat;

  const { data: branding } = await req.supabase
    .from('receipt_branding')
    .select('*')
    .limit(1)
    .maybeSingle();

  const receiptNumber = await nextReceiptNumber(req.supabase);

  const { data, error } = await req.supabase
    .from('receipts')
    .insert({
      business_id: req.params.businessId,
      receipt_number: receiptNumber,
      receipt_type: receiptType,
      line_items: lineItems,
      amount,
      period_label: periodLabel,
      notes,
      stamp_url: branding?.stamp_url || '',
      signature_url: branding?.signature_url || '',
      issued_by: req.user.id,
    })
    .select()
    .single();

  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// @route DELETE /api/businesses/:businessId/receipts/:receiptId
// super_admin only - marks void rather than deleting, so the sequential
// numbering and history stay intact (a gap with a visible reason beats a
// number that silently disappears from the record).
const voidReceipt = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('receipts')
    .update({ status: 'void' })
    .eq('id', req.params.receiptId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route GET /api/businesses/:businessId/receipts/:receiptId/pdf
// Available to the business itself and super_admin - same access as
// listReceipts. Renders the actual stamped document.
const getReceiptPdf = asyncHandler(async (req, res) => {
  const { data: receipt, error } = await req.supabase
    .from('receipts')
    .select('*')
    .eq('id', req.params.receiptId)
    .eq('business_id', req.params.businessId)
    .single();
  if (error || !receipt) return res.status(404).json({ message: 'Receipt not found' });

  const { data: business } = await req.supabase
    .from('businesses')
    .select('name, trn')
    .eq('id', req.params.businessId)
    .single();

  const { data: branding } = await req.supabase
    .from('receipt_branding')
    .select('legal_name, issuer_trn')
    .limit(1)
    .maybeSingle();

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${receipt.receipt_number}.pdf"`);

  const doc = new PDFDocument({ size: 'A4', margin: 56 });
  doc.pipe(res);

  const legalName = branding?.legal_name || 'Tavzio';
  const brass = '#b8925a';
  const ink = '#20170f';

  // Header
  doc.fontSize(22).fillColor(ink).font('Helvetica-Bold').text(legalName, { align: 'left' });
  doc.fontSize(10).fillColor(brass).font('Helvetica').text('Tap. Connect. Grow.', { align: 'left' });
  if (branding?.issuer_trn) {
    doc.fontSize(9).fillColor('#666').font('Helvetica').text(`TRN: ${branding.issuer_trn}`, { align: 'left' });
  }
  doc.moveDown(1.5);

  doc.fontSize(18).fillColor(ink).font('Helvetica-Bold').text('TAX INVOICE', { align: 'right' });
  doc.fontSize(10).fillColor('#666').font('Helvetica')
    .text(`No. ${receipt.receipt_number}`, { align: 'right' })
    .text(`Date: ${new Date(receipt.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}`, { align: 'right' });
  doc.moveDown(1);

  doc.moveTo(56, doc.y).lineTo(539, doc.y).strokeColor(brass).lineWidth(1).stroke();
  doc.moveDown(0.8);

  // Welcome / thank-you framing - every receipt reads as a real piece of
  // correspondence, not just a bare price table. Personalized with the
  // business name; falls back gracefully if it's ever missing.
  const businessName = business?.name || 'your business';
  doc.fontSize(10.5).fillColor('#333').font('Helvetica').text(
    `Welcome to ${legalName}! Thank you for trusting us to power ${businessName}'s digital guest experience. ` +
    `This receipt confirms the services below, issued under the terms of our agreement with you.`,
    { width: 483, align: 'left' }
  );
  doc.moveDown(0.6);

  if (receipt.period_label) {
    doc.fontSize(10.5).fillColor('#333').font('Helvetica').text(receipt.period_label, { width: 483, align: 'left' });
    doc.moveDown(0.6);
  }

  doc.fontSize(11).fillColor(ink).font('Helvetica-Bold').text('Billed to');
  doc.fontSize(11).fillColor('#333').font('Helvetica').text(businessName);
  if (business?.trn) {
    doc.fontSize(9).fillColor('#666').font('Helvetica').text(`Client TRN: ${business.trn}`);
  }
  doc.moveDown(1.2);

  // Line items table
  const tableTop = doc.y;
  doc.fontSize(10).fillColor('#666').font('Helvetica-Bold');
  doc.text('Description', 56, tableTop);
  doc.text('Amount (AED)', 420, tableTop, { width: 119, align: 'right' });
  doc.moveTo(56, tableTop + 16).lineTo(539, tableTop + 16).strokeColor('#ddd').lineWidth(0.5).stroke();

  let y = tableTop + 26;
  doc.font('Helvetica').fillColor('#222');
  (receipt.line_items || []).forEach((item) => {
    const lineHeight = doc.heightOfString(item.description, { width: 340 });
    doc.text(item.description, 56, y, { width: 340 });
    doc.text(Number(item.amount).toFixed(2), 420, y, { width: 119, align: 'right' });
    y += Math.max(lineHeight, 16) + 8;
  });

  doc.moveTo(56, y + 4).lineTo(539, y + 4).strokeColor(brass).lineWidth(1).stroke();

  // VAT breakdown - receipt.amount is the net/subtotal fee (same UAE B2B
  // convention as the contract this receipt is issued under), so VAT is
  // added on top and shown as its own line, not silently folded into
  // the total the way it used to be. Required under UAE Federal
  // Decree-Law No. 8 of 2017 on Value Added Tax for any registered
  // supplier's tax invoice - and the FTA-audit angle this whole receipts
  // system was built around only actually holds up if VAT is broken out
  // explicitly, not just implied.
  // receipt.amount is already VAT-inclusive (the real charged total,
  // see createReceipt/generateContractReceipt) - derive the breakdown
  // backward from it, exactly like customer-facing receipts, not add
  // VAT on top a second time.
  const { subtotalExVat, vatAmount, totalIncVat } = calculateVatInclusive(receipt.amount);
  doc.fontSize(10.5).font('Helvetica').fillColor('#333')
    .text('Subtotal (excl. VAT)', 56, y + 12)
    .text(`AED ${subtotalExVat.toFixed(2)}`, 420, y + 12, { width: 119, align: 'right' });
  doc.text('VAT (5%)', 56, y + 30)
    .text(`AED ${vatAmount.toFixed(2)}`, 420, y + 30, { width: 119, align: 'right' });
  doc.moveTo(56, y + 50).lineTo(539, y + 50).strokeColor('#ddd').lineWidth(0.5).stroke();
  doc.fontSize(13).font('Helvetica-Bold').fillColor(ink)
    .text('Total (incl. VAT)', 56, y + 58)
    .text(`AED ${totalIncVat.toFixed(2)}`, 420, y + 58, { width: 119, align: 'right' });

  // The two calls above leave PDFKit's internal cursor (doc.x) sitting at
  // 420 (the last text call's x) - anything written next without an
  // explicit x would inherit that and get pushed off the right edge.
  // Reset both x and y explicitly to a fresh line below the total.
  let notesY = y + 58 + 26;
  if (receipt.notes) {
    doc.fontSize(10).font('Helvetica-Bold').fillColor(ink).text('Notes', 56, notesY, { width: 483 });
    notesY = doc.y + 4;
    doc.fontSize(10).font('Helvetica').fillColor('#666').text(receipt.notes, 56, notesY, { width: 483 });
  }

  // Stamp and signature - whatever was captured on THIS receipt at the
  // time it was issued, never the currently-active branding.
  const stampY = 680;
  if (receipt.signature_url) {
    try {
      const sigRes = await fetch(receipt.signature_url);
      const sigBuffer = Buffer.from(await sigRes.arrayBuffer());
      doc.image(sigBuffer, 340, stampY, { width: 140 });
      doc.moveTo(340, stampY + 46).lineTo(480, stampY + 46).strokeColor('#999').lineWidth(0.5).stroke();
      doc.fontSize(9).fillColor('#666').text('Authorized signature', 340, stampY + 50);
    } catch {
      // A broken signature URL should never break the whole PDF -
      // everything else still renders correctly without it.
    }
  }
  if (receipt.stamp_url) {
    try {
      const stampRes = await fetch(receipt.stamp_url);
      const stampBuffer = Buffer.from(await stampRes.arrayBuffer());
      doc.image(stampBuffer, 56, stampY - 10, { width: 110 });
    } catch {
      // Same resilience as the signature above.
    }
  }

  doc.end();
});

// @route GET /api/receipt-branding
// super_admin only.
const getReceiptBranding = asyncHandler(async (req, res) => {
  const { data } = await req.supabase.from('receipt_branding').select('*').limit(1).maybeSingle();
  res.json(data || { stamp_url: '', signature_url: '', legal_name: '' });
});

// @route PUT /api/receipt-branding
// super_admin only. Updates the CURRENTLY ACTIVE stamp/signature/legal
// name - affects only receipts created from this point forward.
const updateReceiptBranding = asyncHandler(async (req, res) => {
  const { stampUrl, signatureUrl, legalName, issuerTrn } = req.body;

  // Real, confirmed bug fixed here: this used to select('id') only -
  // meaning `existing` never actually carried the row's current
  // stamp_url/signature_url/legal_name/issuer_trn values at all, so
  // every fallback below (`existing?.stamp_url`) was silently always
  // undefined regardless of what was really saved. Saving just the
  // legal name, for example, would then write '' over a stamp/signature
  // that was very much still supposed to be there - not a display bug,
  // an actual silent data-loss bug on every single save. select('*')
  // is what makes the merge-with-existing logic below actually work as
  // the comments already claimed it did.
  const { data: existing } = await req.supabase.from('receipt_branding').select('*').limit(1).maybeSingle();

  const payload = {
    stamp_url: stampUrl ?? existing?.stamp_url ?? '',
    signature_url: signatureUrl ?? existing?.signature_url ?? '',
    legal_name: legalName ?? existing?.legal_name ?? '',
    issuer_trn: issuerTrn ?? existing?.issuer_trn ?? '',
    updated_at: new Date().toISOString(),
  };

  const { data, error } = existing
    ? await req.supabase.from('receipt_branding').update(payload).eq('id', existing.id).select().single()
    : await req.supabase.from('receipt_branding').insert(payload).select().single();

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/contracts/:contractId/receipts/next
// super_admin only. Generates the next installment receipt for a signed
// contract automatically - amount, period label, and installment number
// all derived from the contract itself, not typed in by hand each time.
const generateContractReceipt = asyncHandler(async (req, res) => {
  const { data: contract } = await req.supabase.from('contracts').select('*').eq('id', req.params.contractId).single();
  if (!contract) return res.status(404).json({ message: 'Contract not found' });
  if (contract.status !== 'signed' && contract.status !== 'active') {
    return res.status(400).json({ message: 'Contract must be signed before receipts can be issued against it' });
  }

  const periodsPerYear = contract.payment_frequency === 'monthly' ? 12 : contract.payment_frequency === 'quarterly' ? 4 : 1;
  const { count: alreadyIssued } = await req.supabase
    .from('receipts')
    .select('id', { count: 'exact', head: true })
    .eq('contract_id', contract.id);
  const installmentNumber = (alreadyIssued || 0) + 1;
  if (installmentNumber > periodsPerYear) {
    return res.status(400).json({ message: 'All installments for this contract term have already been issued' });
  }

  const perPayment = contract.annual_total_aed / periodsPerYear;

  const start = new Date(contract.start_date);
  const periodStart = new Date(start);
  const monthsPerPeriod = 12 / periodsPerYear;
  periodStart.setMonth(periodStart.getMonth() + (installmentNumber - 1) * monthsPerPeriod);
  const periodEnd = new Date(periodStart);
  periodEnd.setMonth(periodEnd.getMonth() + monthsPerPeriod);
  const fmt = (d) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const periodLabel = `Installment ${installmentNumber} of ${periodsPerYear} under Contract ${contract.contract_number}, covering ${fmt(periodStart)} to ${fmt(periodEnd)}.`;

  const lineItems = [
    { description: `Tavzio platform subscription (${contract.payment_frequency} installment under Contract ${contract.contract_number})`, amount: perPayment },
  ];
  // Same rule as createReceipt: line item stays net, amount actually
  // charged is VAT-inclusive - the contract text itself already states
  // both figures, this just makes sure the receipt and the real Ziina
  // charge match what the contract promised, VAT included.
  const amountIncVat = calculateVatExclusive(perPayment).totalIncVat;

  const { data: branding } = await req.supabase.from('receipt_branding').select('*').limit(1).maybeSingle();
  const receiptNumber = await nextReceiptNumber(req.supabase);

  const { data, error } = await req.supabase
    .from('receipts')
    .insert({
      business_id: req.params.businessId,
      receipt_number: receiptNumber,
      receipt_type: 'monthly',
      line_items: lineItems,
      amount: amountIncVat,
      period_label: periodLabel,
      notes: '',
      stamp_url: branding?.stamp_url || '',
      signature_url: branding?.signature_url || '',
      issued_by: req.user.id,
      contract_id: contract.id,
      installment_number: installmentNumber,
      installment_total: periodsPerYear,
    })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

module.exports = {
  listReceipts,
  createReceipt,
  generateContractReceipt,
  voidReceipt,
  getReceiptPdf,
  getReceiptBranding,
  updateReceiptBranding,
};

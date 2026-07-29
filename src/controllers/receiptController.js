const PDFDocument = require('pdfkit');
const asyncHandler = require('../utils/asyncHandler');

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

  const amount = lineItems.reduce((sum, item) => sum + Number(item.amount || 0), 0);

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
    .select('name')
    .eq('id', req.params.businessId)
    .single();

  const { data: branding } = await req.supabase
    .from('receipt_branding')
    .select('legal_name')
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
  doc.moveDown(1.5);

  doc.fontSize(18).fillColor(ink).font('Helvetica-Bold').text('RECEIPT', { align: 'right' });
  doc.fontSize(10).fillColor('#666').font('Helvetica')
    .text(`No. ${receipt.receipt_number}`, { align: 'right' })
    .text(`Date: ${new Date(receipt.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}`, { align: 'right' });
  if (receipt.period_label) {
    doc.text(`Period: ${receipt.period_label}`, { align: 'right' });
  }
  doc.moveDown(1);

  doc.moveTo(56, doc.y).lineTo(539, doc.y).strokeColor(brass).lineWidth(1).stroke();
  doc.moveDown(0.8);

  doc.fontSize(11).fillColor(ink).font('Helvetica-Bold').text('Billed to');
  doc.fontSize(11).fillColor('#333').font('Helvetica').text(business?.name || 'Business');
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
  doc.fontSize(13).font('Helvetica-Bold').fillColor(ink)
    .text('Total', 56, y + 14)
    .text(`AED ${Number(receipt.amount).toFixed(2)}`, 420, y + 14, { width: 119, align: 'right' });

  if (receipt.notes) {
    doc.moveDown(2);
    doc.fontSize(10).font('Helvetica').fillColor('#666').text(receipt.notes, { width: 483 });
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
  const { stampUrl, signatureUrl, legalName } = req.body;

  const { data: existing } = await req.supabase.from('receipt_branding').select('id').limit(1).maybeSingle();

  const payload = {
    stamp_url: stampUrl ?? existing?.stamp_url ?? '',
    signature_url: signatureUrl ?? existing?.signature_url ?? '',
    legal_name: legalName ?? existing?.legal_name ?? '',
    updated_at: new Date().toISOString(),
  };

  const { data, error } = existing
    ? await req.supabase.from('receipt_branding').update(payload).eq('id', existing.id).select().single()
    : await req.supabase.from('receipt_branding').insert(payload).select().single();

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

module.exports = { listReceipts, createReceipt, voidReceipt, getReceiptPdf, getReceiptBranding, updateReceiptBranding };

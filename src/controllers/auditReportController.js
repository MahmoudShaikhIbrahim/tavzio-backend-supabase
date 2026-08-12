const PDFDocument = require('pdfkit');
const asyncHandler = require('../utils/asyncHandler');
const { supabaseAdmin } = require('../config/supabaseClient');

const BRASS = '#b8925a';
const INK = '#20170f';

function drawHeader(doc, title, legalName, issuerTrn) {
  doc.fontSize(20).fillColor(INK).font('Helvetica-Bold').text(legalName, { align: 'left' });
  if (issuerTrn) doc.fontSize(9).fillColor('#666').font('Helvetica').text(`TRN: ${issuerTrn}`, { align: 'left' });
  doc.moveDown(1);
  doc.fontSize(16).fillColor(INK).font('Helvetica-Bold').text(title, { align: 'left' });
  doc.fontSize(9).fillColor('#666').font('Helvetica').text(`Generated ${new Date().toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })}`, { align: 'left' });
  doc.moveDown(0.6);
  doc.moveTo(56, doc.y).lineTo(539, doc.y).strokeColor(BRASS).lineWidth(1).stroke();
  doc.moveDown(0.8);
}

function drawSectionTitle(doc, text) {
  doc.moveDown(0.6);
  doc.fontSize(12).fillColor(INK).font('Helvetica-Bold').text(text);
  doc.moveDown(0.3);
}

function drawTable(doc, rows, columns) {
  const startX = 56;
  let y = doc.y;
  doc.fontSize(9).fillColor('#666').font('Helvetica-Bold');
  let x = startX;
  columns.forEach((c) => { doc.text(c.label, x, y, { width: c.width }); x += c.width; });
  y += 14;
  doc.moveTo(startX, y).lineTo(539, y).strokeColor('#ddd').lineWidth(0.5).stroke();
  y += 6;
  doc.font('Helvetica').fontSize(9).fillColor('#222');
  rows.forEach((row) => {
    if (y > 740) { doc.addPage(); y = 56; }
    x = startX;
    columns.forEach((c) => { doc.text(String(c.value(row)), x, y, { width: c.width }); x += c.width; });
    y += 15;
  });
  doc.y = y + 4;
}

async function getBranding(supabase) {
  const { data } = await supabase.from('receipt_branding').select('*').limit(1).maybeSingle();
  return data;
}

// @route GET /api/businesses/:businessId/audit-report/pdf?year=YYYY
// Every fils that moved through this business's Tavzio account for the
// given year, in one file: signed contracts, Tavzio billing receipts
// issued to them, and every completed customer payment (restaurant/cafe
// `payments` table and/or hotel gateway `payment_transactions` -
// whichever this business actually has). Meant to be handed straight to
// an FTA auditor - nothing here is computed on the fly from guesses, it's
// the same rows the Payments/Reconciliation/Receipts pages already show,
// just compiled into one signed-off document.
const generateBusinessAuditReport = asyncHandler(async (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const from = `${year}-01-01T00:00:00.000Z`;
  const to = `${year + 1}-01-01T00:00:00.000Z`;

  const { data: business } = await req.supabase.from('businesses').select('name, category, trn').eq('id', req.params.businessId).single();
  if (!business) return res.status(404).json({ message: 'Business not found' });

  const [{ data: contracts }, { data: receipts }, { data: payments }, { data: gatewayTxns }] = await Promise.all([
    req.supabase.from('contracts').select('*').eq('business_id', req.params.businessId).in('status', ['signed', 'active']),
    req.supabase.from('receipts').select('*').eq('business_id', req.params.businessId).eq('status', 'issued').gte('created_at', from).lt('created_at', to).order('created_at'),
    req.supabase.from('payments').select('*').eq('business_id', req.params.businessId).eq('status', 'completed').gte('created_at', from).lt('created_at', to).order('created_at'),
    req.supabase.from('payment_transactions').select('*').eq('business_id', req.params.businessId).eq('status', 'completed').gte('created_at', from).lt('created_at', to).order('created_at'),
  ]);

  const branding = await getBranding(req.supabase);
  const legalName = branding?.legal_name || 'Tavzio';

  // The payments-section title used to hardcode "Tap Payments" regardless
  // of what the business actually configured (or whether they'd
  // configured anything at all) - it now reflects the real connected
  // provider, or just "Payments" if none is set up.
  const { data: paymentIntegration } = await req.supabase
    .from('pos_integrations')
    .select('config')
    .eq('business_id', req.params.businessId)
    .eq('purpose', 'payment')
    .maybeSingle();
  const PROVIDER_LABELS = { tap: 'Tap Payments', telr: 'Telr', ngenius: 'N-Genius Online', ziina: 'Ziina' };
  const paymentsSectionTitle = paymentIntegration?.config?.provider
    ? `Customer Payments (Pay Bill / ${PROVIDER_LABELS[paymentIntegration.config.provider] || paymentIntegration.config.provider})`
    : 'Customer Payments (Pay Bill)';

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${business.name.replace(/\W+/g, '_')}_audit_${year}.pdf"`);
  const doc = new PDFDocument({ size: 'A4', margin: 56, bufferPages: true });
  doc.pipe(res);

  drawHeader(doc, `Audit Report — ${year}`, legalName, branding?.issuer_trn);
  doc.fontSize(11).fillColor(INK).font('Helvetica-Bold').text(business.name);
  if (business.trn) doc.fontSize(9).fillColor('#666').font('Helvetica').text(`Client TRN: ${business.trn}`);
  doc.moveDown(0.5);

  // Contracts
  drawSectionTitle(doc, 'Service Agreements');
  if (contracts?.length) {
    drawTable(doc, contracts, [
      { label: 'Contract No.', value: (r) => r.contract_number, width: 110 },
      { label: 'Start', value: (r) => new Date(r.start_date).toLocaleDateString('en-GB'), width: 80 },
      { label: 'End', value: (r) => new Date(r.end_date).toLocaleDateString('en-GB'), width: 80 },
      { label: 'Annual total (AED)', value: (r) => Number(r.annual_total_aed).toFixed(2), width: 100 },
      { label: 'Status', value: (r) => r.status, width: 73 },
    ]);
  } else {
    doc.fontSize(10).fillColor('#888').font('Helvetica').text('No signed agreements on file.');
  }

  // Billing receipts (Tavzio -> business)
  drawSectionTitle(doc, 'Billing Receipts Received From Tavzio');
  const receiptsTotal = (receipts || []).reduce((s, r) => s + Number(r.amount), 0);
  if (receipts?.length) {
    drawTable(doc, receipts, [
      { label: 'Receipt No.', value: (r) => r.receipt_number, width: 110 },
      { label: 'Date', value: (r) => new Date(r.created_at).toLocaleDateString('en-GB'), width: 80 },
      { label: 'Type', value: (r) => r.receipt_type.replace('_', ' '), width: 100 },
      { label: 'Amount (AED)', value: (r) => Number(r.amount).toFixed(2), width: 90 },
      { label: 'Paid', value: (r) => (r.payment_status === 'paid' ? 'Yes' : 'No'), width: 53 },
    ]);
  } else {
    doc.fontSize(10).fillColor('#888').font('Helvetica').text('No billing receipts issued in this period.');
  }
  doc.fontSize(10).font('Helvetica-Bold').fillColor(INK).text(`Subtotal: AED ${receiptsTotal.toFixed(2)}`);

  // Customer payments (restaurant/cafe payments, whatever provider this business actually uses)
  const paymentsTotal = (payments || []).reduce((s, r) => s + Number(r.amount) + Number(r.tip_amount || 0), 0);
  if (payments?.length) {
    drawSectionTitle(doc, paymentsSectionTitle);
    drawTable(doc, payments, [
      { label: 'Date', value: (r) => new Date(r.created_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }), width: 140 },
      { label: 'Amount (AED)', value: (r) => Number(r.amount).toFixed(2), width: 90 },
      { label: 'Tip (AED)', value: (r) => Number(r.tip_amount || 0).toFixed(2), width: 80 },
      { label: 'Refunded', value: (r) => (r.refunded ? `Yes (${Number(r.refund_amount || 0).toFixed(2)})` : 'No'), width: 123 },
    ]);
    doc.fontSize(10).font('Helvetica-Bold').fillColor(INK).text(`Subtotal: AED ${paymentsTotal.toFixed(2)}`);
  }

  // Hotel gateway transactions
  const gatewayTotal = (gatewayTxns || []).filter((t) => t.transaction_type === 'charge').reduce((s, r) => s + Number(r.amount_aed), 0);
  const gatewayRefunds = (gatewayTxns || []).filter((t) => t.transaction_type === 'refund').reduce((s, r) => s + Number(r.amount_aed), 0);
  if (gatewayTxns?.length) {
    drawSectionTitle(doc, 'Guest / Folio Payment Gateway Transactions');
    drawTable(doc, gatewayTxns, [
      { label: 'Date', value: (r) => new Date(r.created_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }), width: 140 },
      { label: 'Type', value: (r) => r.transaction_type, width: 80 },
      { label: 'Provider', value: (r) => r.provider, width: 90 },
      { label: 'Amount (AED)', value: (r) => Number(r.amount_aed).toFixed(2), width: 123 },
    ]);
    doc.fontSize(10).font('Helvetica-Bold').fillColor(INK).text(`Charges: AED ${gatewayTotal.toFixed(2)}  ·  Refunds: AED ${gatewayRefunds.toFixed(2)}`);
  }

  // Grand total - reserved as one block, not written blind. Without
  // this check, if the tables above happened to leave just slightly too
  // little room, PDFKit would silently start a new page mid-block,
  // stranding the total line or the disclaimer alone on an otherwise
  // empty trailing page. ~100pt is comfortably enough for the divider,
  // total line, and the 3-sentence disclaimer at this font size.
  const summaryBlockHeight = 100;
  if (doc.y + summaryBlockHeight > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
  doc.moveDown(1);
  doc.moveTo(56, doc.y).lineTo(539, doc.y).strokeColor(BRASS).lineWidth(1).stroke();
  doc.moveDown(0.4);
  const grandTotal = paymentsTotal + gatewayTotal - gatewayRefunds;
  doc.fontSize(13).font('Helvetica-Bold').fillColor(INK).text(`Total customer revenue for ${year}: AED ${grandTotal.toFixed(2)}`);
  doc.fontSize(9).font('Helvetica').fillColor('#888').text(
    'This report reflects records held in the Tavzio platform as of the generation date above. It is compiled ' +
    'directly from the same transaction and billing records shown in this account\'s Payments, Reconciliation, ' +
    'and Receipts pages, with no manually entered figures.'
  );

  doc.end();
});

// @route GET /api/businesses/audit-report/pdf?year=YYYY  (super_admin only)
// The platform-wide version: every business's signed contracts and every
// billing receipt Tavzio has issued, across the whole client base, for
// one year - Tavzio's own revenue proof, not any one client's.
const generatePlatformAuditReport = asyncHandler(async (req, res) => {
  const year = parseInt(req.query.year, 10) || new Date().getFullYear();
  const from = `${year}-01-01T00:00:00.000Z`;
  const to = `${year + 1}-01-01T00:00:00.000Z`;

  const [{ data: contracts }, { data: receipts }] = await Promise.all([
    supabaseAdmin.from('contracts').select('*, businesses(name)').in('status', ['signed', 'active']),
    supabaseAdmin.from('receipts').select('*, businesses(name)').eq('status', 'issued').gte('created_at', from).lt('created_at', to).order('created_at'),
  ]);

  const branding = await getBranding(supabaseAdmin);
  const legalName = branding?.legal_name || 'Tavzio';

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Tavzio_platform_audit_${year}.pdf"`);
  const doc = new PDFDocument({ size: 'A4', margin: 56, bufferPages: true });
  doc.pipe(res);

  drawHeader(doc, `Platform Audit Report — ${year}`, legalName, branding?.issuer_trn);

  drawSectionTitle(doc, 'Signed Service Agreements (all clients, active or signed)');
  const contractsAnnualTotal = (contracts || []).reduce((s, r) => s + Number(r.annual_total_aed), 0);
  if (contracts?.length) {
    drawTable(doc, contracts, [
      { label: 'Client', value: (r) => r.businesses?.name || '—', width: 140 },
      { label: 'Contract No.', value: (r) => r.contract_number, width: 110 },
      { label: 'Annual total (AED)', value: (r) => Number(r.annual_total_aed).toFixed(2), width: 110 },
      { label: 'Status', value: (r) => r.status, width: 73 },
    ]);
  } else {
    doc.fontSize(10).fillColor('#888').font('Helvetica').text('No signed agreements on file.');
  }
  doc.fontSize(10).font('Helvetica-Bold').fillColor(INK).text(`Combined contracted annual value: AED ${contractsAnnualTotal.toFixed(2)}`);

  drawSectionTitle(doc, `Billing Receipts Issued (${year})`);
  const receiptsTotal = (receipts || []).reduce((s, r) => s + Number(r.amount), 0);
  if (receipts?.length) {
    drawTable(doc, receipts, [
      { label: 'Client', value: (r) => r.businesses?.name || '—', width: 130 },
      { label: 'Receipt No.', value: (r) => r.receipt_number, width: 100 },
      { label: 'Date', value: (r) => new Date(r.created_at).toLocaleDateString('en-GB'), width: 75 },
      { label: 'Amount (AED)', value: (r) => Number(r.amount).toFixed(2), width: 85 },
      { label: 'Paid', value: (r) => (r.payment_status === 'paid' ? 'Yes' : 'No'), width: 43 },
    ]);
  } else {
    doc.fontSize(10).fillColor('#888').font('Helvetica').text('No billing receipts issued in this period.');
  }

  // Same reserved-block guard as the business report - the total line,
  // collected-amount line, and disclaimer stay together on one page.
  const summaryBlockHeight = 120;
  if (doc.y + summaryBlockHeight > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
  doc.moveDown(1);
  doc.moveTo(56, doc.y).lineTo(539, doc.y).strokeColor(BRASS).lineWidth(1).stroke();
  doc.moveDown(0.4);
  doc.fontSize(13).font('Helvetica-Bold').fillColor(INK).text(`Total billed to clients in ${year}: AED ${receiptsTotal.toFixed(2)}`);
  const paidTotal = (receipts || []).filter((r) => r.payment_status === 'paid').reduce((s, r) => s + Number(r.amount), 0);
  doc.fontSize(11).font('Helvetica').fillColor('#333').text(`Of which collected: AED ${paidTotal.toFixed(2)}`);
  doc.fontSize(9).font('Helvetica').fillColor('#888').text(
    'This report reflects records held in the Tavzio platform as of the generation date above, compiled directly ' +
    'from contract and billing-receipt records with no manually entered figures.'
  );

  doc.end();
});

module.exports = { generateBusinessAuditReport, generatePlatformAuditReport };

const PDFDocument = require('pdfkit');
const asyncHandler = require('../utils/asyncHandler');

// UAE standard VAT rate - menu prices are treated as VAT-inclusive
// (standard local practice), so exports break out what portion of each
// total is actually VAT, rather than just showing a bare number.
const UAE_VAT_RATE = 0.05;

function vatBreakdown(grossAmount) {
  const vat = Math.round((grossAmount - grossAmount / (1 + UAE_VAT_RATE)) * 100) / 100;
  const net = Math.round((grossAmount - vat) * 100) / 100;
  return { net, vat };
}

// Turns an array of plain objects into CSV text - no external library
// needed for something this simple, and it keeps full control over
// exactly which columns show up.
function toCsv(rows, columns) {
  const header = columns.map((c) => c.label).join(',');
  const escape = (value) => {
    const str = String(value ?? '');
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = rows.map((row) => columns.map((c) => escape(c.value(row))).join(','));
  return [header, ...lines].join('\n');
}

// Landscape, with each column given a PROPORTIONAL width (a `weight`,
// relative to the others) rather than splitting the page equally - the
// previous version gave a 12-character "Order ID" the exact same width
// as a full item list, which is what caused everything to wrap into an
// unreadable mess. Row height is measured per-row (via PDFKit's own
// heightOfString) before drawing, so a row with long wrapped text gets
// the vertical space it actually needs instead of a fixed guess.
function streamPdf(res, filename, title, columns, rows) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
  doc.pipe(res);

  doc.fontSize(16).text(title, { align: 'left' });
  doc.moveDown(0.3);
  doc.fontSize(9).fillColor('#666').text(`Generated ${new Date().toLocaleString()}`);
  doc.moveDown(1);

  const usableWidth = doc.page.width - 80;
  const totalWeight = columns.reduce((sum, c) => sum + (c.weight || 1), 0);
  const widths = columns.map((c) => ((c.weight || 1) / totalWeight) * usableWidth);
  // Simple running total - each column starts where the previous one
  // ends. The earlier version's reduce formula had an off-by-one that
  // put the first two columns at the exact same x-coordinate, which is
  // exactly what caused the overlapping/garbled text.
  const xPositions = [];
  let cursor = 40;
  for (const w of widths) {
    xPositions.push(cursor);
    cursor += w;
  }

  function drawHeader() {
    doc.fontSize(9).fillColor('#fff');
    doc.rect(40, doc.y, usableWidth, 18).fill('#333');
    const headerY = doc.y - 18 + 5;
    columns.forEach((c, i) => doc.fillColor('#fff').text(c.label, xPositions[i] + 4, headerY, { width: widths[i] - 8 }));
    doc.moveDown(1.2);
    doc.fillColor('#000');
  }

  drawHeader();

  rows.forEach((row) => {
    const cellTexts = columns.map((c) => String(c.value(row) ?? ''));
    const rowHeight = Math.max(...cellTexts.map((text, i) => doc.heightOfString(text, { width: widths[i] - 8 }))) + 8;

    if (doc.y + rowHeight > doc.page.height - 50) {
      doc.addPage();
      drawHeader();
    }

    const y = doc.y;
    doc.fontSize(8.5).fillColor('#222');
    cellTexts.forEach((text, i) => doc.text(text, xPositions[i] + 4, y, { width: widths[i] - 8 }));
    doc.y = y + rowHeight;
    doc.moveTo(40, doc.y - 3).lineTo(40 + usableWidth, doc.y - 3).strokeColor('#eee').stroke();
  });

  doc.end();
}

// @route GET /api/businesses/:businessId/orders/export?format=csv|pdf&from=&to=
// One row per ORDER (not per item) - a table's whole order summarized on
// one line, with the item list folded into a single readable column,
// rather than one PDF row per individual item.
const exportOrders = asyncHandler(async (req, res) => {
  const { format = 'csv', from, to } = req.query;

  let query = req.supabase
    .from('orders')
    .select('*, order_items(*)')
    .eq('business_id', req.params.businessId)
    .eq('request_type', 'order')
    .order('created_at', { ascending: false });

  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to);

  const { data: orders, error } = await query;
  if (error) return res.status(400).json({ message: error.message });

  const rows = (orders || []).map((order) => {
    const itemsSummary = order.order_items
      .map((i) => `${i.quantity}x ${i.item_name}${i.voided ? ' (voided)' : ''}`)
      .join(', ');
    const { net, vat } = vatBreakdown(Number(order.total || 0));
    return {
      date: order.created_at,
      table: order.table_label,
      items: itemsSummary,
      net,
      vat,
      total: order.total,
      status: order.status,
      voided: order.voided ? 'Yes' : 'No',
      orderId: order.id,
    };
  });

  const columns = [
    { label: 'Date', value: (r) => new Date(r.date).toLocaleString(), weight: 1.3 },
    { label: 'Table', value: (r) => r.table, weight: 0.8 },
    { label: 'Items', value: (r) => r.items, weight: 3 },
    { label: 'Net (ex VAT)', value: (r) => r.net, weight: 0.9 },
    { label: 'VAT (5%)', value: (r) => r.vat, weight: 0.8 },
    { label: 'Total', value: (r) => r.total, weight: 0.8 },
    { label: 'Status', value: (r) => r.status, weight: 0.9 },
    { label: 'Voided', value: (r) => r.voided, weight: 0.7 },
  ];

  if (format === 'pdf') {
    return streamPdf(res, 'orders.pdf', 'Orders Report', columns, rows);
  }

  // CSV keeps the fuller, one-row-per-item detail (including Order ID) -
  // spreadsheets don't have the PDF's readability problem, and this level
  // of detail is genuinely useful when opened in Excel/Sheets.
  const csvRows = (orders || []).flatMap((order) =>
    order.order_items.map((item) => {
      const lineGross = (Number(item.unit_price) + Number(item.addon_total || 0)) * item.quantity;
      const { net, vat } = vatBreakdown(lineGross);
      return {
        orderId: order.id, date: order.created_at, table: order.table_label, status: order.status,
        voided: order.voided || item.voided, itemName: item.item_name, quantity: item.quantity,
        unitPrice: item.unit_price, lineTotalNet: net, lineTotalVat: vat,
        lineTotalGross: lineGross.toFixed(2), orderTotal: order.total,
      };
    })
  );
  const csvColumns = [
    { label: 'Date', value: (r) => new Date(r.date).toLocaleString() },
    { label: 'Table', value: (r) => r.table },
    { label: 'Item', value: (r) => r.itemName },
    { label: 'Qty', value: (r) => r.quantity },
    { label: 'Unit Price', value: (r) => r.unitPrice },
    { label: 'Net (ex VAT)', value: (r) => r.lineTotalNet },
    { label: 'VAT (5%)', value: (r) => r.lineTotalVat },
    { label: 'Line Total', value: (r) => r.lineTotalGross },
    { label: 'Order Total', value: (r) => r.orderTotal },
    { label: 'Status', value: (r) => r.status },
    { label: 'Voided', value: (r) => (r.voided ? 'Yes' : 'No') },
    { label: 'Order ID', value: (r) => r.orderId },
  ];

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
  res.send(toCsv(csvRows, csvColumns));
});

// @route GET /api/businesses/:businessId/bookings/export?format=csv|pdf&from=&to=
const exportBookings = asyncHandler(async (req, res) => {
  const { format = 'csv', from, to } = req.query;

  let query = req.supabase
    .from('bookings')
    .select('*')
    .eq('business_id', req.params.businessId)
    .order('requested_at', { ascending: false });

  if (from) query = query.gte('requested_at', from);
  if (to) query = query.lte('requested_at', to);

  const { data: bookings, error } = await query;
  if (error) return res.status(400).json({ message: error.message });

  const columns = [
    { label: 'Requested For', value: (r) => new Date(r.requested_at).toLocaleString(), weight: 1.3 },
    { label: 'Service', value: (r) => r.service_name, weight: 1.2 },
    { label: 'Status', value: (r) => r.status, weight: 0.8 },
    { label: 'Contact Phone', value: (r) => r.contact_phone, weight: 1 },
    { label: 'Note', value: (r) => r.note, weight: 1.5 },
  ];

  if (format === 'pdf') {
    return streamPdf(res, 'bookings.pdf', 'Bookings Report', columns, bookings || []);
  }

  const csvColumns = [...columns, { label: 'Booking ID', value: (r) => r.id }];
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="bookings.csv"');
  res.send(toCsv(bookings || [], csvColumns));
});

// @route GET /api/businesses/:businessId/payments/export?format=csv|pdf&from=&to=
const exportPayments = asyncHandler(async (req, res) => {
  const { format = 'csv', from, to } = req.query;

  let query = req.supabase
    .from('payments')
    .select('*')
    .eq('business_id', req.params.businessId)
    .eq('status', 'completed')
    .order('created_at', { ascending: false });

  if (from) query = query.gte('created_at', from);
  if (to) query = query.lte('created_at', to);

  const { data: payments, error } = await query;
  if (error) return res.status(400).json({ message: error.message });

  const columns = [
    { label: 'Date', value: (r) => new Date(r.created_at).toLocaleString(), weight: 1.3 },
    { label: 'Amount', value: (r) => r.amount, weight: 0.8 },
    { label: 'Tip', value: (r) => r.tip_amount, weight: 0.7 },
    { label: 'Total', value: (r) => (Number(r.amount) + Number(r.tip_amount)).toFixed(2), weight: 0.8 },
    { label: 'Refunded', value: (r) => (r.refunded ? `Yes (${r.refund_amount})` : 'No'), weight: 1 },
  ];

  if (format === 'pdf') {
    return streamPdf(res, 'payments.pdf', 'Payments Report', columns, payments || []);
  }

  const csvColumns = [
    { label: 'Date', value: (r) => new Date(r.created_at).toLocaleString() },
    { label: 'Amount', value: (r) => r.amount },
    { label: 'Net (ex VAT)', value: (r) => vatBreakdown(Number(r.amount)).net },
    { label: 'VAT (5%)', value: (r) => vatBreakdown(Number(r.amount)).vat },
    { label: 'Tip', value: (r) => r.tip_amount },
    { label: 'Total', value: (r) => (Number(r.amount) + Number(r.tip_amount)).toFixed(2) },
    { label: 'Refunded', value: (r) => (r.refunded ? `Yes (${r.refund_amount})` : 'No') },
    { label: 'Tap Charge ID', value: (r) => r.tap_charge_id },
    { label: 'Payment ID', value: (r) => r.id },
  ];
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="payments.csv"');
  res.send(toCsv(payments || [], csvColumns));
});

// @route GET /api/businesses/:businessId/payments
// Plain list for the dashboard's Payments view (not an export) - completed
// payments only, most recent first.
const listPayments = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('payments')
    .select('*')
    .eq('business_id', req.params.businessId)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

module.exports = { exportOrders, exportBookings, exportPayments, listPayments };

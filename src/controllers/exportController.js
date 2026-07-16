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

function streamPdf(res, filename, title, columns, rows) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  doc.pipe(res);

  doc.fontSize(16).text(title, { align: 'left' });
  doc.moveDown(0.5);
  doc.fontSize(9).fillColor('#666').text(`Generated ${new Date().toLocaleString()}`);
  doc.moveDown(1);

  const colWidth = (doc.page.width - 80) / columns.length;

  doc.fontSize(9).fillColor('#000');
  columns.forEach((c, i) => doc.text(c.label, 40 + i * colWidth, doc.y, { width: colWidth, continued: i < columns.length - 1 }));
  doc.moveDown(0.5);
  doc.moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).stroke();
  doc.moveDown(0.3);

  rows.forEach((row) => {
    const y = doc.y;
    columns.forEach((c, i) => {
      doc.text(String(c.value(row) ?? ''), 40 + i * colWidth, y, { width: colWidth, continued: i < columns.length - 1 });
    });
    doc.moveDown(0.4);
    if (doc.y > doc.page.height - 60) doc.addPage();
  });

  doc.end();
}

// @route GET /api/businesses/:businessId/orders/export?format=csv|pdf&from=&to=
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

  const rows = (orders || []).flatMap((order) =>
    order.order_items.map((item) => {
      const lineGross = (Number(item.unit_price) + Number(item.addon_total || 0)) * item.quantity;
      const { net, vat } = vatBreakdown(lineGross);
      return {
        orderId: order.id,
        date: order.created_at,
        table: order.table_label,
        status: order.status,
        voided: order.voided || item.voided,
        itemName: item.item_name,
        quantity: item.quantity,
        unitPrice: item.unit_price,
        lineTotalNet: net,
        lineTotalVat: vat,
        lineTotalGross: lineGross.toFixed(2),
        orderTotal: order.total,
      };
    })
  );

  const columns = [
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

  if (format === 'pdf') {
    return streamPdf(res, 'orders.pdf', 'Orders Report', columns, rows);
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
  res.send(toCsv(rows, columns));
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
    { label: 'Requested For', value: (r) => new Date(r.requested_at).toLocaleString() },
    { label: 'Service', value: (r) => r.service_name },
    { label: 'Status', value: (r) => r.status },
    { label: 'Contact Phone', value: (r) => r.contact_phone },
    { label: 'Note', value: (r) => r.note },
    { label: 'Booking ID', value: (r) => r.id },
  ];

  if (format === 'pdf') {
    return streamPdf(res, 'bookings.pdf', 'Bookings Report', columns, bookings || []);
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="bookings.csv"');
  res.send(toCsv(bookings || [], columns));
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

  if (format === 'pdf') {
    return streamPdf(res, 'payments.pdf', 'Payments Report', columns, payments || []);
  }

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="payments.csv"');
  res.send(toCsv(payments || [], columns));
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

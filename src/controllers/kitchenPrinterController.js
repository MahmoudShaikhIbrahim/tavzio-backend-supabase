const asyncHandler = require('../utils/asyncHandler');
const { printKitchenTickets } = require('../utils/kitchenTicketPrinter');
const { logAction } = require('../utils/auditLog');

// @route GET /api/businesses/:businessId/kitchen-station-printers
const listKitchenStationPrinters = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('kitchen_station_printers')
    .select('*')
    .eq('business_id', req.params.businessId)
    .order('station');
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route PUT /api/businesses/:businessId/kitchen-station-printers
// Body: { station, printerId, printerName }
// One station per row (unique business_id+station) - re-mapping a
// station to a different printer is just calling this again, upsert
// handles the replace.
const upsertKitchenStationPrinter = asyncHandler(async (req, res) => {
  const { station, printerId, printerName } = req.body;
  if (!station?.trim() || !printerId) {
    return res.status(400).json({ message: 'station and printerId are required' });
  }

  const { data, error } = await req.supabase
    .from('kitchen_station_printers')
    .upsert(
      { business_id: req.params.businessId, station: station.trim(), printer_id: String(printerId), printer_name: printerName || '' },
      { onConflict: 'business_id,station' }
    )
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  await logAction({ businessId: req.params.businessId, actor: req.user, action: 'kitchen_printer_mapped', targetId: data.id, details: { station: data.station, printerName: data.printer_name } });
  res.json(data);
});

// @route DELETE /api/businesses/:businessId/kitchen-station-printers/:id
// Removing a mapping just means that station goes back to screen-only
// (Kitchen's own KDS view) - never affects whether the order itself
// reaches the kitchen, only whether it also gets a paper ticket.
const deleteKitchenStationPrinter = asyncHandler(async (req, res) => {
  const { error } = await req.supabase
    .from('kitchen_station_printers')
    .delete()
    .eq('id', req.params.id)
    .eq('business_id', req.params.businessId);
  if (error) return res.status(400).json({ message: error.message });
  res.json({ message: 'Printer mapping removed' });
});

// @route POST /api/businesses/:businessId/orders/:orderId/reprint-ticket
// Controlled reprint - a real, named action (shows up in the audit log
// with who and when), not a silent re-send. Reprints every currently
// fired, unvoided item on the order across all its mapped stations -
// the real case this covers is a lost or misprinted paper ticket, not
// a way to quietly re-fire an order the kitchen already started.
const reprintKitchenTicket = asyncHandler(async (req, res) => {
  const { data: order } = await req.supabase
    .from('orders')
    .select('table_label, note, order_type, order_items(*)')
    .eq('id', req.params.orderId)
    .eq('business_id', req.params.businessId)
    .single();
  if (!order) return res.status(404).json({ message: 'Order not found' });

  const items = order.order_items.filter((i) => !i.voided && i.course_status !== 'held');
  if (items.length === 0) return res.status(400).json({ message: 'No fired items on this order to reprint' });

  await printKitchenTickets(req.params.businessId, { tableLabel: order.table_label, note: order.note, orderType: order.order_type, items });

  await logAction({ businessId: req.params.businessId, actor: req.user, action: 'kitchen_ticket_reprinted', targetId: req.params.orderId, details: { tableLabel: order.table_label } });
  res.json({ message: 'Reprint sent' });
});

module.exports = { listKitchenStationPrinters, upsertKitchenStationPrinter, deleteKitchenStationPrinter, reprintKitchenTicket };

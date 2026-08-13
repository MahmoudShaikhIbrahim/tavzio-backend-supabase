const { supabaseAdmin } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { logAction } = require('../utils/auditLog');
const { sendPrintJob } = require('../utils/printNodeAdapter');
const { UAE_VAT_RATE, calculateVatInclusive } = require('../utils/vat');
const { decryptConfig } = require('../utils/credentialEncryption');

function vatBreakdown(grossAmount) {
  const { subtotalExVat, vatAmount } = calculateVatInclusive(grossAmount);
  return { net: subtotalExVat, vat: vatAmount };
}

// @route GET /api/businesses/:businessId/tables
// Every card (table) that currently has at least one unpaid, non-voided
// item somewhere on it - built for a business with ordering on but no
// Pay Bill, so this is the only place staff can see "what does this
// table currently owe" as a real total, without a printer or POS.
const listTablesWithUnpaid = asyncHandler(async (req, res) => {
  const { data: orders, error } = await req.supabase
    .from('orders')
    .select('card_id, table_label, order_items(id, paid, voided, unit_price, addon_total, quantity)')
    .eq('business_id', req.params.businessId)
    .eq('request_type', 'order')
    .eq('voided', false)
    .neq('status', 'awaiting_payment')
    .neq('status', 'cancelled');
  if (error) return res.status(400).json({ message: error.message });

  const byCard = new Map();
  for (const order of orders || []) {
    if (!order.card_id) continue;
    const unpaid = order.order_items.filter((i) => !i.paid && !i.voided);
    if (unpaid.length === 0) continue;
    const total = unpaid.reduce((sum, i) => sum + (i.unit_price + Number(i.addon_total || 0)) * i.quantity, 0);
    const existing = byCard.get(order.card_id) || { cardId: order.card_id, tableLabel: order.table_label, total: 0, itemCount: 0 };
    existing.total += total;
    existing.itemCount += unpaid.length;
    byCard.set(order.card_id, existing);
  }

  res.json(Array.from(byCard.values()).sort((a, b) => a.tableLabel.localeCompare(b.tableLabel)));
});

// @route GET /api/businesses/:businessId/tables/:cardId/receipt
// Everything unpaid for one table, itemized - the source data for the
// adjustable Table Receipts screen before printing.
const getTableReceipt = asyncHandler(async (req, res) => {
  const { data: orders, error } = await req.supabase
    .from('orders')
    .select('id, table_label, order_items(*)')
    .eq('business_id', req.params.businessId)
    .eq('card_id', req.params.cardId)
    .eq('request_type', 'order')
    .eq('voided', false)
    .neq('status', 'awaiting_payment')
    .neq('status', 'cancelled');
  if (error) return res.status(400).json({ message: error.message });

  const items = (orders || []).flatMap((o) => o.order_items.filter((i) => !i.paid && !i.voided));
  const tableLabel = orders?.[0]?.table_label || '';
  const subtotal = items.reduce((sum, i) => sum + (i.unit_price + Number(i.addon_total || 0)) * i.quantity, 0);
  const { net, vat } = vatBreakdown(subtotal);

  res.json({ tableLabel, items, subtotal, net, vat, total: subtotal });
});

// @route POST /api/businesses/:businessId/tables/:cardId/receipt/print
// Body: { removedItemIds?: string[] }
// Removing an item here is display-only - it changes what prints on the
// paper, never the real order/order_items (kitchen records, analytics,
// and what's actually owed all stay untouched). Every removal is logged
// to the audit trail so there's a real record of who adjusted a bill and
// what was taken off it.
const printTableReceipt = asyncHandler(async (req, res) => {
  const { removedItemIds = [] } = req.body;

  const { data: orders, error } = await req.supabase
    .from('orders')
    .select('id, table_label, order_items(*)')
    .eq('business_id', req.params.businessId)
    .eq('card_id', req.params.cardId)
    .eq('request_type', 'order')
    .eq('voided', false)
    .neq('status', 'awaiting_payment')
    .neq('status', 'cancelled');
  if (error) return res.status(400).json({ message: error.message });

  const allItems = (orders || []).flatMap((o) => o.order_items.filter((i) => !i.paid && !i.voided));
  const removedSet = new Set(removedItemIds);
  const finalItems = allItems.filter((i) => !removedSet.has(i.id));
  const removedItems = allItems.filter((i) => removedSet.has(i.id));

  if (finalItems.length === 0) {
    return res.status(400).json({ message: 'Nothing left to print - every item was removed' });
  }

  const subtotal = finalItems.reduce((sum, i) => sum + (i.unit_price + Number(i.addon_total || 0)) * i.quantity, 0);
  const { net, vat } = vatBreakdown(subtotal);
  const tableLabel = orders?.[0]?.table_label || '';

  const { data: business } = await req.supabase.from('businesses').select('name').eq('id', req.params.businessId).single();

  for (const item of removedItems) {
    await logAction({
      businessId: req.params.businessId,
      actor: req.user,
      action: 'receipt_item_removed',
      targetId: item.id,
      details: {
        tableLabel,
        itemName: item.item_name,
        quantity: item.quantity,
        amount: (item.unit_price + Number(item.addon_total || 0)) * item.quantity,
      },
    });
  }

  const lines = [];
  lines.push((business?.name || 'Tavzio').toUpperCase());
  lines.push(`Table: ${tableLabel}`);
  lines.push(new Date().toLocaleString('en-GB'));
  lines.push('--------------------------------');
  for (const item of finalItems) {
    const lineTotal = ((item.unit_price + Number(item.addon_total || 0)) * item.quantity).toFixed(2);
    lines.push(`${item.quantity}x ${item.item_name}`.padEnd(24) + lineTotal.padStart(8));
  }
  lines.push('--------------------------------');
  lines.push('Net'.padEnd(24) + net.toFixed(2).padStart(8));
  lines.push(`VAT (${(UAE_VAT_RATE * 100).toFixed(0)}%)`.padEnd(24) + vat.toFixed(2).padStart(8));
  lines.push('TOTAL'.padEnd(24) + subtotal.toFixed(2).padStart(8));
  lines.push('--------------------------------');
  lines.push('Please present this to your');
  lines.push('server with payment.');
  const receiptText = lines.join('\n');

  const { data: printerIntegration } = await supabaseAdmin
    .from('pos_integrations')
    .select('*')
    .eq('business_id', req.params.businessId)
    .eq('purpose', 'printing')
    .eq('enabled', true)
    .maybeSingle();

  let printResult = { success: false, error: 'No printer connected' };
  if (printerIntegration) {
    printResult = await sendPrintJob(decryptConfig(printerIntegration.config), receiptText);
  }

  // Always return the formatted text too - if there's no printer
  // connected (or the print job fails), the frontend falls back to the
  // browser's own print dialog with this exact content, never a dead end.
  res.json({
    tableLabel,
    items: finalItems,
    subtotal,
    net,
    vat,
    receiptText,
    printed: printResult.success,
    printError: printResult.success ? null : printResult.error,
  });
});

module.exports = { listTablesWithUnpaid, getTableReceipt, printTableReceipt };

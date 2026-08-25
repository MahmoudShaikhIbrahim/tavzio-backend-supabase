const { supabaseAdmin } = require('../config/supabaseClient');
const { decryptConfig } = require('./credentialEncryption');
const { sendPrintJob } = require('./printNodeAdapter');

// Real ticket format - plain text lines, matching sendPrintJob's own
// raw_base64 requirement (works on any thermal printer PrintNode's
// Client already has configured, no per-printer template needed).
function formatTicket({ station, tableLabel, items, note, orderType }) {
  const lines = [
    `=== ${station || 'KITCHEN'} ===`,
    tableLabel || orderType || '',
    new Date().toLocaleTimeString(),
    '--------------------------------',
  ];
  for (const item of items) {
    lines.push(`${item.quantity}x ${item.item_name}`);
    if (item.addons?.length) lines.push(`  + ${item.addons.map((a) => a.name).join(', ')}`);
    if (item.note) lines.push(`  (${item.note})`);
  }
  if (note) lines.push('--------------------------------', `NOTE: ${note}`);
  lines.push('--------------------------------', '');
  return lines.join('\n');
}

// Groups the given items by station, prints one real ticket per station
// that has a configured printer. Items with no station (or a station
// with no printer mapped) are silently skipped here - the always-on
// Kitchen screen (KitchenPage.tsx) already shows every item regardless,
// so a missing printer mapping never means an order gets lost, only
// that it doesn't ALSO get a paper ticket for that station.
//
// Never throws - a printer being offline or unreachable should never
// block an order from reaching the kitchen screen or the customer's
// receipt. Every failure is caught and swallowed per-station so one
// dead printer can't take down every other station's tickets too.
async function printKitchenTickets(businessId, { tableLabel, note, orderType, items }) {
  const byStation = new Map();
  for (const item of items) {
    const station = (item.station || '').trim();
    if (!station) continue;
    if (!byStation.has(station)) byStation.set(station, []);
    byStation.get(station).push(item);
  }
  if (byStation.size === 0) return;

  const { data: printingIntegration } = await supabaseAdmin
    .from('pos_integrations')
    .select('config, enabled')
    .eq('business_id', businessId)
    .eq('purpose', 'printing')
    .maybeSingle();
  if (!printingIntegration?.enabled) return; // no printing set up at all - screen-only, same as before this existed

  const apiKey = decryptConfig(printingIntegration.config)?.apiKey;
  if (!apiKey) return;

  const { data: mappings } = await supabaseAdmin
    .from('kitchen_station_printers')
    .select('station, printer_id')
    .eq('business_id', businessId)
    .in('station', Array.from(byStation.keys()));

  for (const mapping of mappings || []) {
    const stationItems = byStation.get(mapping.station);
    if (!stationItems) continue;
    const ticket = formatTicket({ station: mapping.station, tableLabel, items: stationItems, note, orderType });
    sendPrintJob({ apiKey, printerId: mapping.printer_id }, ticket).catch(() => {});
  }
}

module.exports = { printKitchenTickets, formatTicket };

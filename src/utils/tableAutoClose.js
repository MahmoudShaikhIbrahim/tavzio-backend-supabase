// =========================================================================
// Auto-close a table the moment its whole bill is settled - by any
// method (online Pay Bill, a redirect provider confirming, or a staff
// manual payment). Call this after any action that marks an item paid.
//
// Different from clearTable (which staff trigger manually and which
// deliberately LEAVES fully-paid orders untouched, since a table might
// still owe money elsewhere): this only ever acts when literally
// nothing is owed anymore, and when it acts, it closes EVERYTHING for
// that card - including the now-fully-paid orders - so a new tap shows
// a genuinely fresh, empty bill instead of yesterday's paid history.
// =========================================================================
async function maybeAutoCloseTable(supabaseAdmin, businessId, cardId) {
  if (!cardId) return;

  const { data: orders } = await supabaseAdmin
    .from('orders')
    .select('id, order_items(paid, voided)')
    .eq('business_id', businessId)
    .eq('card_id', cardId)
    .eq('request_type', 'order')
    .eq('voided', false);

  if (!orders || orders.length === 0) return;

  const anyUnpaidRemaining = orders.some((o) => o.order_items.some((i) => !i.paid && !i.voided));
  if (anyUnpaidRemaining) return; // still owes something - leave it alone

  await supabaseAdmin
    .from('orders')
    .update({ voided: true, void_reason: 'Fully paid - auto-closed' })
    .in('id', orders.map((o) => o.id))
    .eq('voided', false);
}

module.exports = { maybeAutoCloseTable };

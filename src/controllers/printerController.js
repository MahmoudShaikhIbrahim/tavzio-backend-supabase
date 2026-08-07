const { supabaseAdmin } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { listPrinters } = require('../utils/printNodeAdapter');
const { logAction } = require('../utils/auditLog');

// @route GET /api/businesses/:businessId/printer-integration
// business_owner only - full config including the raw PrintNode API key.
// Same lockdown as the payment integration - RLS enforces this
// independently (migration 0029), not just this route check.
const getPrinterIntegration = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('pos_integrations')
    .select('*')
    .eq('business_id', req.params.businessId)
    .eq('purpose', 'printing')
    .maybeSingle();

  if (error) return res.status(400).json({ message: error.message });
  res.json(data || null);
});

// @route POST /api/businesses/:businessId/printer-integration/printers
// business_owner only. Body: { apiKey }
// Lets the owner see their real printer list before picking one - never
// asks them to type a raw printer id blind.
const listAvailablePrinters = asyncHandler(async (req, res) => {
  const { apiKey } = req.body;
  const result = await listPrinters(apiKey);
  if (!result.success) return res.status(400).json({ message: result.error });
  res.json({ printers: result.printers });
});

// @route PUT /api/businesses/:businessId/printer-integration
// business_owner only. Body: { enabled, apiKey, printerId, printerName }
const upsertPrinterIntegration = asyncHandler(async (req, res) => {
  const { enabled, apiKey, printerId, printerName } = req.body;

  const { data, error } = await req.supabase
    .from('pos_integrations')
    .upsert(
      {
        business_id: req.params.businessId,
        purpose: 'printing',
        provider: 'printnode',
        enabled: !!enabled,
        config: { apiKey: apiKey || '', printerId: printerId || '', printerName: printerName || '' },
        status: enabled ? 'connected' : 'disconnected',
      },
      { onConflict: 'business_id,purpose' }
    )
    .select()
    .single();

  if (error) return res.status(400).json({ message: error.message });

  await logAction({
    businessId: req.params.businessId,
    actor: req.user,
    action: 'payment_integration_updated',
    targetId: data.id,
    // Deliberately never the actual API key - just what changed.
    details: { purpose: 'printing', provider: 'printnode', enabled: data.enabled, printerName },
  });

  res.json(data);
});

// @route GET /api/businesses/:businessId/printer-integration/status
// Owner, staff, AND super_admin can all see this - connected/not-connected
// only, never the raw API key. Uses supabaseAdmin deliberately, same
// approved narrow window as the payment status endpoint.
const getPrinterStatus = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('pos_integrations')
    .select('enabled, status, config')
    .eq('business_id', req.params.businessId)
    .eq('purpose', 'printing')
    .maybeSingle();

  if (error) return res.status(400).json({ message: error.message });
  res.json(data ? { enabled: data.enabled, status: data.status, printerName: data.config?.printerName || '' } : null);
});

module.exports = { getPrinterIntegration, listAvailablePrinters, upsertPrinterIntegration, getPrinterStatus };

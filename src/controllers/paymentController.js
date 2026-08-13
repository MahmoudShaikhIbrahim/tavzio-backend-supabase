const { supabaseAdmin } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { logAction } = require('../utils/auditLog');
const { encryptConfig, decryptConfig } = require('../utils/credentialEncryption');

// @route GET /api/businesses/:businessId/payment-integration
// business_owner only - full config including the Tap secret key.
// RLS enforces this independently (see migration 0009) - even a bug here
// wouldn't leak the raw key to anyone but the owner.
const getPaymentIntegration = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('pos_integrations')
    .select('*')
    .eq('business_id', req.params.businessId)
    .eq('purpose', 'payment')
    .maybeSingle();

  if (error) return res.status(400).json({ message: error.message });
  res.json(data ? { ...data, config: decryptConfig(data.config) } : null);
});

// @route PUT /api/businesses/:businessId/payment-integration
// business_owner only. Body: { provider: 'tap', enabled, config: { secretKey } }
const upsertPaymentIntegration = asyncHandler(async (req, res) => {
  const { enabled, config } = req.body;

  const { data, error } = await req.supabase
    .from('pos_integrations')
    .upsert(
      {
        business_id: req.params.businessId,
        purpose: 'payment',
        provider: config?.provider || 'tap',
        enabled: !!enabled,
        config: encryptConfig(config || {}),
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
    // Deliberately never the actual secret key - just what changed
    // about the setting itself.
    details: { provider: data.provider, enabled: data.enabled },
  });

  // Return the readable config the owner just submitted, not the
  // encrypted blob just written - res.json(data) would otherwise hand
  // back ciphertext where the frontend expects to redisplay the form.
  res.json({ ...data, config: config || {} });
});

// @route GET /api/businesses/:businessId/payment-integration/status
// Owner, staff, AND super_admin can all see this - connected/not-connected
// only, never the secret key itself. Uses supabaseAdmin deliberately: RLS
// blocks everyone but the owner from the raw table, so this is the one
// approved, narrow window into it for support purposes.
const getPaymentStatus = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('pos_integrations')
    .select('enabled, status')
    .eq('business_id', req.params.businessId)
    .eq('purpose', 'payment')
    .maybeSingle();

  if (error) return res.status(400).json({ message: error.message });
  res.json(data || null);
});

module.exports = { getPaymentIntegration, upsertPaymentIntegration, getPaymentStatus };

const { supabaseAdmin } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');

const ORDERING_PROVIDERS = ['foodics', 'square', 'loyverse'];
const BOOKING_PROVIDERS = ['zenoti', 'fresha', 'square'];

// @route GET /api/businesses/:businessId/pos-integration?purpose=ordering|booking
// super_admin only - full record including config (credentials).
const getIntegration = asyncHandler(async (req, res) => {
  const purpose = req.query.purpose === 'booking' ? 'booking' : 'ordering';

  const { data, error } = await req.supabase
    .from('pos_integrations')
    .select('*')
    .eq('business_id', req.params.businessId)
    .eq('purpose', purpose)
    .maybeSingle();

  if (error) return res.status(400).json({ message: error.message });
  res.json(data || null);
});

// @route PUT /api/businesses/:businessId/pos-integration
// super_admin only. Body: { purpose: 'ordering'|'booking', provider, enabled, config }
const upsertIntegration = asyncHandler(async (req, res) => {
  const { purpose, provider, enabled, config } = req.body;

  if (purpose !== 'ordering' && purpose !== 'booking') {
    return res.status(400).json({ message: 'purpose must be "ordering" or "booking"' });
  }
  const validProviders = purpose === 'ordering' ? ORDERING_PROVIDERS : BOOKING_PROVIDERS;
  if (!validProviders.includes(provider)) {
    return res.status(400).json({ message: `"${provider}" doesn't support ${purpose} integration` });
  }

  const { data, error } = await req.supabase
    .from('pos_integrations')
    .upsert(
      {
        business_id: req.params.businessId,
        purpose,
        provider,
        enabled: !!enabled,
        config: config || {},
        status: enabled ? 'connected' : 'disconnected',
      },
      { onConflict: 'business_id,purpose' }
    )
    .select()
    .single();

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route GET /api/businesses/:businessId/pos-integration/status?purpose=ordering|booking
// Owner/staff-safe: provider + enabled + status only, never the config
// blob (API tokens etc). Uses supabaseAdmin deliberately - RLS on
// pos_integrations blocks owner/staff entirely, so this is the one
// approved, narrow window into it, not a bypass of the access rule.
const getIntegrationStatus = asyncHandler(async (req, res) => {
  const purpose = req.query.purpose === 'booking' ? 'booking' : 'ordering';

  const { data, error } = await supabaseAdmin
    .from('pos_integrations')
    .select('provider, enabled, status, last_synced_at')
    .eq('business_id', req.params.businessId)
    .eq('purpose', purpose)
    .maybeSingle();

  if (error) return res.status(400).json({ message: error.message });
  res.json(data || null);
});

// @route PATCH /api/businesses/:businessId/pos-integration/toggle?purpose=ordering|booking
// Owner, staff, AND super_admin can flip this - deliberately narrower than
// getIntegration/upsertIntegration above: it only ever touches `enabled`,
// never `config`, so credentials stay untouched and unseen by anyone but
// super_admin. Uses supabaseAdmin for the same reason getIntegrationStatus
// does - RLS blocks owner/staff from this table entirely, so this is one
// more approved, narrow window into it, not a bypass of the access rule.
const toggleIntegrationEnabled = asyncHandler(async (req, res) => {
  const purpose = req.query.purpose === 'booking' ? 'booking' : 'ordering';
  const { enabled } = req.body;

  const { data: existing } = await supabaseAdmin
    .from('pos_integrations')
    .select('id')
    .eq('business_id', req.params.businessId)
    .eq('purpose', purpose)
    .maybeSingle();
  if (!existing) {
    return res.status(404).json({ message: 'No integration configured yet for this business - ask the platform operator to set one up first' });
  }

  const { data, error } = await supabaseAdmin
    .from('pos_integrations')
    .update({ enabled: !!enabled, status: enabled ? 'connected' : 'disconnected' })
    .eq('id', existing.id)
    .select('provider, enabled, status, last_synced_at')
    .single();

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

module.exports = { getIntegration, upsertIntegration, getIntegrationStatus, toggleIntegrationEnabled, ORDERING_PROVIDERS, BOOKING_PROVIDERS };

const asyncHandler = require('../utils/asyncHandler');

const PROVIDER_INFO = {
  siteminder: { role: 'channel_manager', label: 'SiteMinder', requirement: 'Approved SiteMinder partner account (Integration Application Form review) + pmsXchange API credentials' },
  opera_cloud: { role: 'pms', label: 'Oracle OPERA Cloud', requirement: 'Oracle Partner Network membership ($500/yr) + Hospitality track approval + OHIP credentials (billed per API call)' },
  simphony: { role: 'pos', label: 'Oracle MICROS Simphony', requirement: 'Oracle Hospitality partner account + Simphony Transaction Services credentials' },
  shiji_infrasys: { role: 'pos', label: 'Shiji Infrasys', requirement: 'Shiji integration partner registration + Infrasys API credentials' },
  shiji_daylight: { role: 'pms', label: 'Shiji Daylight PMS', requirement: 'Shiji integration partner registration + Daylight API credentials' },
};

const listExternalIntegrations = asyncHandler(async (req, res) => {
  const { data } = await req.supabase.from('external_hotel_integrations').select('*').eq('business_id', req.params.businessId);
  const byProvider = Object.fromEntries((data || []).map((d) => [d.provider, d]));

  const result = Object.entries(PROVIDER_INFO).map(([provider, info]) => ({
    provider,
    ...info,
    connected: !!byProvider[provider],
    enabled: byProvider[provider]?.enabled || false,
    externalPropertyId: byProvider[provider]?.external_property_id || '',
  }));
  res.json(result);
});

const connectExternalIntegration = asyncHandler(async (req, res) => {
  const { provider } = req.params;
  const info = PROVIDER_INFO[provider];
  if (!info) return res.status(400).json({ message: 'Unknown provider' });

  const externalPropertyId = String(req.body.externalPropertyId || '').trim();
  if (!externalPropertyId) {
    return res.status(400).json({ message: 'Property ID is required to connect' });
  }

  const { data, error } = await req.supabase
    .from('external_hotel_integrations')
    .upsert({ business_id: req.params.businessId, provider, role: info.role, external_property_id: externalPropertyId }, { onConflict: 'business_id,provider' })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// Lets an owner back out of a connection entirely - previously there was
// no way off this screen once a row existed, even an empty/placeholder
// one, which is exactly what left people stuck looking at "Awaiting real
// credentials" with nothing to press.
const disconnectExternalIntegration = asyncHandler(async (req, res) => {
  const { provider } = req.params;
  if (!PROVIDER_INFO[provider]) return res.status(400).json({ message: 'Unknown provider' });

  const { error } = await req.supabase
    .from('external_hotel_integrations')
    .delete()
    .eq('business_id', req.params.businessId)
    .eq('provider', provider);
  if (error) return res.status(400).json({ message: error.message });
  res.json({ message: 'Disconnected' });
});

module.exports = { listExternalIntegrations, connectExternalIntegration, disconnectExternalIntegration };

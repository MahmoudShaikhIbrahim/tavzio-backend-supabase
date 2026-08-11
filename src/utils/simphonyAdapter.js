// =========================================================================
// Oracle MICROS Simphony (hotel F&B POS) - part of the same Oracle
// Hospitality partner ecosystem as OPERA Cloud/OHIP (393 verified
// integration partners per public directory data), so the same Oracle
// Partner Network approval is the real prerequisite here too. Simphony
// exposes Transaction Services APIs for check/order data - exact
// endpoint shapes require an approved partner account to access.
// =========================================================================

function getCredentials() {
  const orgShortName = process.env.SIMPHONY_ORG_SHORT_NAME;
  const locationRef = process.env.SIMPHONY_LOCATION_REF;
  const clientId = process.env.SIMPHONY_CLIENT_ID;
  const clientSecret = process.env.SIMPHONY_CLIENT_SECRET;
  if (!orgShortName || !locationRef || !clientId || !clientSecret) return null;
  return { orgShortName, locationRef, clientId, clientSecret };
}

async function pushOrderToSimphony(order, items) {
  const creds = getCredentials();
  if (!creds) return { success: false, error: 'Oracle Simphony is not configured yet (needs an Oracle Hospitality partner account - see Settings > External Systems)' };
  return { success: false, error: 'Not yet implemented - awaiting real Simphony Transaction Services credentials to build and test against' };
}

module.exports = { pushOrderToSimphony, getCredentials };

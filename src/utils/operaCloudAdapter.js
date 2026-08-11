// =========================================================================
// Oracle OPERA Cloud, via OHIP (Oracle Hospitality Integration Platform)
// - verified against Oracle's real docs. OHIP is REST-based (3,000+
// endpoints), which is the correct, current path (not the legacy
// SOAP/XML OWS/OXI interfaces).
//
// Real prerequisites, confirmed: joining the Oracle Partner Network
// (OPN, $500/year) and getting approved for the "Hospitality" expertise
// track, then requesting Oracle Hospitality Developer Portal access.
// OHIP itself is billed per API call (~$10 per 10,000 REST calls) once
// live - there is no free or self-serve tier. Every function below
// fails safely until OPERA_OHIP_CLIENT_ID/SECRET exist.
// =========================================================================

function getCredentials() {
  const clientId = process.env.OPERA_OHIP_CLIENT_ID;
  const clientSecret = process.env.OPERA_OHIP_CLIENT_SECRET;
  const hotelId = process.env.OPERA_HOTEL_ID;
  if (!clientId || !clientSecret || !hotelId) return null;
  return { clientId, clientSecret, hotelId };
}

async function getRoomStatus(roomNumber) {
  const creds = getCredentials();
  if (!creds) return { success: false, error: 'Oracle OPERA Cloud is not configured yet (needs an OPN Hospitality-track partner account - see Settings > External Systems)' };
  return { success: false, error: 'Not yet implemented - awaiting real OHIP credentials to build and test against' };
}

async function postFolioCharge({ roomNumber, description, amountAed }) {
  const creds = getCredentials();
  if (!creds) return { success: false, error: 'Oracle OPERA Cloud is not configured yet' };
  return { success: false, error: 'Not yet implemented' };
}

module.exports = { getRoomStatus, postFolioCharge, getCredentials };

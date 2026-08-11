// =========================================================================
// SiteMinder channel manager (pmsXchange API) - verified against
// SiteMinder's real developer docs. Since Tavzio acts as the PMS,
// pmsXchange is the correct API (not SiteConnect/Channels Plus, which
// are for booking-channel partners, not PMS partners): "a two-way API
// to push availability, rates, and restrictions, and synchronise
// reservations in real time."
//
// Real prerequisite before any call here can work: SiteMinder requires
// becoming an approved partner via their Integration Application Form,
// reviewed on their end - there is no self-serve API key. Until
// SITEMINDER_API_KEY exists, every function below fails safely.
// =========================================================================

function getCredentials() {
  const apiKey = process.env.SITEMINDER_API_KEY;
  const hotelCode = process.env.SITEMINDER_HOTEL_CODE;
  if (!apiKey || !hotelCode) return null;
  return { apiKey, hotelCode };
}

// Pushes current room availability/rates out to every OTA connected
// through SiteMinder - the "central inventory" half that actually needs
// this partnership (Tavzio's own double-booking prevention already
// covers bookings made directly through Tavzio).
async function pushAvailability({ roomTypeCode, dateRange, availableRooms, rateAed }) {
  const creds = getCredentials();
  if (!creds) return { success: false, error: 'SiteMinder is not configured yet (needs an approved partner account - see Settings > External Systems)' };
  // Real pmsXchange call would go here once credentials exist - the
  // request/response shape depends on the exact ARI (Availability, Rate,
  // Inventory) push format from SiteMinder's pmsXchange spec, which
  // requires an approved partner account to access in full.
  return { success: false, error: 'Not yet implemented - awaiting real pmsXchange credentials to build and test against' };
}

// Receives a reservation SiteMinder is pushing in from a connected OTA -
// this would be the actual webhook/polling endpoint once the real
// pmsXchange reservation sync spec is available to build against.
async function receiveReservation(payload) {
  const creds = getCredentials();
  if (!creds) return { success: false, error: 'SiteMinder is not configured yet' };
  return { success: false, error: 'Not yet implemented' };
}

module.exports = { pushAvailability, receiveReservation, getCredentials };

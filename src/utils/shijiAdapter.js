// =========================================================================
// Shiji Infrasys (hotel F&B POS) and Shiji Daylight PMS - verified
// against Shiji's real integration documentation (docs.shijigroup.com
// hosts a real "Authentication and Configuration" guide for their
// Integration API). Both require registering as a Shiji integration
// partner to receive real API credentials - no self-serve tier found.
// =========================================================================

function getInfrasysCredentials() {
  const apiKey = process.env.SHIJI_INFRASYS_API_KEY;
  const propertyCode = process.env.SHIJI_INFRASYS_PROPERTY_CODE;
  if (!apiKey || !propertyCode) return null;
  return { apiKey, propertyCode };
}

function getDaylightCredentials() {
  const apiKey = process.env.SHIJI_DAYLIGHT_API_KEY;
  const propertyCode = process.env.SHIJI_DAYLIGHT_PROPERTY_CODE;
  if (!apiKey || !propertyCode) return null;
  return { apiKey, propertyCode };
}

async function pushOrderToInfrasys(order, items) {
  const creds = getInfrasysCredentials();
  if (!creds) return { success: false, error: 'Shiji Infrasys is not configured yet (needs a Shiji integration partner account - see Settings > External Systems)' };
  return { success: false, error: 'Not yet implemented - awaiting real Infrasys credentials to build and test against' };
}

async function getDaylightRoomStatus(roomNumber) {
  const creds = getDaylightCredentials();
  if (!creds) return { success: false, error: 'Shiji Daylight PMS is not configured yet (needs a Shiji integration partner account - see Settings > External Systems)' };
  return { success: false, error: 'Not yet implemented - awaiting real Daylight cashiering/reservation API credentials to build and test against' };
}

async function postDaylightFolioCharge({ roomNumber, description, amountAed }) {
  const creds = getDaylightCredentials();
  if (!creds) return { success: false, error: 'Shiji Daylight PMS is not configured yet' };
  return { success: false, error: 'Not yet implemented' };
}

module.exports = {
  pushOrderToInfrasys, getInfrasysCredentials,
  getDaylightRoomStatus, postDaylightFolioCharge, getDaylightCredentials,
};

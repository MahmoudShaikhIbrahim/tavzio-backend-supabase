// =========================================================================
// Verify Now (Message Central) OTP verification - the ONLY thing SMS is
// used for in this whole codebase: verifying a phone number for online
// booking. Nothing else sends SMS (marketingController.js explicitly
// blocks SMS campaigns for exactly this reason - no provider connected
// for general SMS, only for booking OTP verification).
//
// Unlike a raw SMS sender (Twilio, etc), Verify Now generates and checks
// the OTP itself - we never see or store the code. sendOtp() returns a
// verificationId; validateOtp() is later called with that verificationId
// plus whatever the customer typed in, and Verify Now tells us if it
// matched. Same graceful-missing-config pattern as before: this logs and
// returns a clear failure rather than throwing when MC_* env vars aren't
// set yet, so the rest of the booking flow can be built and reviewed
// before real Message Central credentials exist.
// =========================================================================

const BASE_URL = 'https://cpaas.messagecentral.com';

// Auth tokens are valid for ~24h per Message Central's docs - cache in
// memory so we're not fetching a new one on every OTP request.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAuthToken() {
  const customerId = process.env.MC_CUSTOMER_ID;
  const password = process.env.MC_PASSWORD;
  const email = process.env.MC_EMAIL;

  if (!customerId || !password || !email) {
    throw new Error('Message Central is not configured (MC_CUSTOMER_ID / MC_PASSWORD / MC_EMAIL)');
  }

  if (cachedToken && Date.now() < cachedTokenExpiresAt) {
    return cachedToken;
  }

  const key = Buffer.from(password).toString('base64');
  const url = `${BASE_URL}/auth/v1/authentication/token?customerId=${encodeURIComponent(customerId)}&key=${encodeURIComponent(key)}&scope=NEW&country=971&email=${encodeURIComponent(email)}`;

  const response = await fetch(url, { headers: { accept: '*/*' } });
  const data = await response.json();
  if (!response.ok || !data.token) {
    throw new Error(data.message || 'Could not authenticate with Message Central');
  }

  cachedToken = data.token;
  // Cache for 23h to stay safely inside their ~24h token TTL.
  cachedTokenExpiresAt = Date.now() + 23 * 60 * 60 * 1000;
  return cachedToken;
}

// Sends a Verify Now-generated OTP to the given phone number.
// Returns { success: true, verificationId } or { success: false, error }.
async function sendOtp(phone) {
  const customerId = process.env.MC_CUSTOMER_ID;
  if (!customerId) {
    console.error('Message Central is not configured (MC_CUSTOMER_ID / MC_PASSWORD / MC_EMAIL) - OTP SMS was not sent.');
    return { success: false, error: 'SMS verification is not available right now' };
  }

  try {
    const authToken = await getAuthToken();
    // UAE country code, digits-only mobile number (no leading +/00/971).
    const mobileNumber = String(phone).replace(/\D/g, '').replace(/^971/, '').replace(/^0/, '');
    const url = `${BASE_URL}/verification/v3/send?countryCode=971&customerId=${encodeURIComponent(customerId)}&flowType=SMS&mobileNumber=${encodeURIComponent(mobileNumber)}&otpLength=6`;

    const response = await fetch(url, { method: 'POST', headers: { authToken } });
    const data = await response.json();
    if (!response.ok || !data?.data?.verificationId) {
      return { success: false, error: data.message || 'Could not send verification code' };
    }
    return { success: true, verificationId: data.data.verificationId };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Validates a customer-entered code against Verify Now's verificationId.
// Returns { success: true } or { success: false, error }.
async function validateOtp(verificationId, code) {
  try {
    const authToken = await getAuthToken();
    const url = `${BASE_URL}/verification/v3/validateOtp?verificationId=${encodeURIComponent(verificationId)}&code=${encodeURIComponent(code)}`;

    const response = await fetch(url, { headers: { authToken } });
    const data = await response.json();
    if (!response.ok) {
      return { success: false, error: data.message || 'Could not validate verification code' };
    }
    if (data?.data?.verificationStatus !== 'VERIFICATION_COMPLETED') {
      return { success: false, error: 'Incorrect code' };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { sendOtp, validateOtp };

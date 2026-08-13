// =========================================================================
// Zoho Books connector (accounting sync)
// =========================================================================
// Real, documented Zoho Books API v3 - https://www.zoho.com/books/api/v3/
// Each business connects THEIR OWN Zoho Books organization (same "Option
// A" architecture as the payment gateway adapters: Tavzio only ever
// calls the API using an OAuth grant the business itself approved,
// scoped to their own Zoho org, never a Tavzio-wide Zoho account).
//
// What gets synced: Tavzio's own billing receipts to this business, as
// a vendor Bill in their Zoho Books (money they owe/paid to Tavzio,
// their software vendor) - not customer sales data. See CredentialsPage
// for the reasoning on why this was the first sync target chosen.
// =========================================================================

const ZOHO_ENV_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_ENV_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_ENV_REDIRECT_URI = process.env.ZOHO_REDIRECT_URI;

function buildAuthorizeUrl({ accountsUrl, state }) {
  const scope = [
    'ZohoBooks.contacts.CREATE', 'ZohoBooks.contacts.READ',
    'ZohoBooks.bills.CREATE', 'ZohoBooks.bills.READ',
    'ZohoBooks.settings.READ',
  ].join(',');
  const params = new URLSearchParams({
    scope,
    client_id: ZOHO_ENV_CLIENT_ID,
    response_type: 'code',
    redirect_uri: ZOHO_ENV_REDIRECT_URI,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${accountsUrl}/oauth/v2/auth?${params.toString()}`;
}

// Exchanges the grant code from the OAuth callback for real access +
// refresh tokens. Per Zoho's docs, this must be a POST with the params
// in the query string (not a JSON body) - confirmed directly from their
// own request examples, not assumed.
async function exchangeCodeForTokens({ accountsUrl, code }) {
  if (!ZOHO_ENV_CLIENT_ID || !ZOHO_ENV_CLIENT_SECRET || !ZOHO_ENV_REDIRECT_URI) {
    return { success: false, error: 'Zoho Books is not configured on this server (ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REDIRECT_URI missing)' };
  }
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: ZOHO_ENV_CLIENT_ID,
    client_secret: ZOHO_ENV_CLIENT_SECRET,
    redirect_uri: ZOHO_ENV_REDIRECT_URI,
    code,
  });
  const response = await fetch(`${accountsUrl}/oauth/v2/token?${params.toString()}`, { method: 'POST' });
  const data = await response.json();
  if (!response.ok || data.error) {
    return { success: false, error: data.error || 'Could not exchange authorization code' };
  }
  return {
    success: true,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    apiDomain: data.api_domain,
    expiresInSeconds: data.expires_in,
  };
}

// Access tokens are valid for exactly 1 hour (Zoho's own stated limit) -
// this regenerates one from the permanent refresh token, same token
// endpoint, different grant_type.
async function refreshAccessToken({ accountsUrl, refreshToken }) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: ZOHO_ENV_CLIENT_ID,
    client_secret: ZOHO_ENV_CLIENT_SECRET,
    refresh_token: refreshToken,
  });
  const response = await fetch(`${accountsUrl}/oauth/v2/token?${params.toString()}`, { method: 'POST' });
  const data = await response.json();
  if (!response.ok || data.error) {
    return { success: false, error: data.error || 'Could not refresh Zoho Books access token' };
  }
  return { success: true, accessToken: data.access_token, apiDomain: data.api_domain, expiresInSeconds: data.expires_in };
}

// Every Zoho Books API call needs the org's numeric organization_id as
// a query param, and the token as a non-standard bearer scheme
// ("Zoho-oauthtoken", not "Bearer") - both confirmed directly from
// Zoho's own request examples.
async function zohoRequest({ apiDomain, accessToken, organizationId, method, path, body }) {
  const url = new URL(`${apiDomain}/books/v3${path}`);
  url.searchParams.set('organization_id', organizationId);
  const response = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok || data.code !== 0) {
    return { success: false, error: data.message || `Zoho Books API error (status ${response.status})` };
  }
  return { success: true, data };
}

// Zoho Books requires an org to be selected before any other call works
// (a Zoho login can have several). Takes the first one, matching the
// common single-org case - a business connecting a multi-org Zoho
// account will need to pick manually in a future version.
async function listOrganizations({ apiDomain, accessToken }) {
  const response = await fetch(`${apiDomain}/books/v3/organizations`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  const data = await response.json();
  if (!response.ok || data.code !== 0) return { success: false, error: data.message || 'Could not list Zoho organizations' };
  return { success: true, organizations: data.organizations || [] };
}

// Finds "Tavzio" as an existing vendor contact, or creates it - only
// ever needs to happen once per business, then the contact ID is cached
// in zoho_books_integrations.vendor_contact_id.
async function findOrCreateTavzioVendorContact({ apiDomain, accessToken, organizationId, legalName }) {
  const search = await zohoRequest({
    apiDomain, accessToken, organizationId, method: 'GET',
    path: `/contacts?contact_name=${encodeURIComponent(legalName)}`,
  });
  if (search.success && search.data.contacts?.length > 0) {
    return { success: true, contactId: search.data.contacts[0].contact_id };
  }

  const created = await zohoRequest({
    apiDomain, accessToken, organizationId, method: 'POST',
    path: '/contacts',
    body: { contact_name: legalName, contact_type: 'vendor' },
  });
  if (!created.success) return created;
  return { success: true, contactId: created.data.contact.contact_id };
}

// The actual sync: one Tavzio billing receipt becomes one Zoho Books
// Bill against the Tavzio vendor contact. Field shapes (vendor_id,
// bill_number, line_items with name/rate/quantity) confirmed directly
// against Zoho's own Bills API reference, not guessed.
async function createBillFromReceipt({ apiDomain, accessToken, organizationId, vendorContactId, receipt }) {
  return zohoRequest({
    apiDomain, accessToken, organizationId, method: 'POST',
    path: '/bills',
    body: {
      vendor_id: vendorContactId,
      bill_number: receipt.receipt_number,
      date: new Date(receipt.created_at).toISOString().slice(0, 10),
      line_items: [
        {
          name: receipt.period_label || receipt.receipt_type.replace('_', ' '),
          rate: Number(receipt.amount),
          quantity: 1,
        },
      ],
    },
  });
}

module.exports = {
  buildAuthorizeUrl, exchangeCodeForTokens, refreshAccessToken,
  listOrganizations, findOrCreateTavzioVendorContact, createBillFromReceipt,
};

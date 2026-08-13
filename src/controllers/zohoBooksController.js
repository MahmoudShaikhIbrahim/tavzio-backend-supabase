const asyncHandler = require('../utils/asyncHandler');
const crypto = require('crypto');
const { supabaseAdmin } = require('../config/supabaseClient');
const { encryptString, decryptString } = require('../utils/credentialEncryption');
const {
  buildAuthorizeUrl, exchangeCodeForTokens, refreshAccessToken,
  listOrganizations, findOrCreateTavzioVendorContact, createBillFromReceipt,
} = require('../utils/zohoBooksAdapter');

const ZOHO_ACCOUNTS_URL = process.env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com';

// @route GET /api/businesses/:businessId/zoho-books/connect
// Returns the real Zoho consent URL to redirect the owner to - state
// carries the businessId through the OAuth round trip, since Zoho's
// callback has no other way to know which Tavzio business initiated this.
const getConnectUrl = asyncHandler(async (req, res) => {
  const state = Buffer.from(JSON.stringify({
    businessId: req.params.businessId,
    nonce: crypto.randomBytes(16).toString('hex'),
  })).toString('base64url');
  const url = buildAuthorizeUrl({ accountsUrl: ZOHO_ACCOUNTS_URL, state });
  res.json({ url });
});

// @route GET /api/zoho-books/callback?code=&state=
// Public (Zoho redirects the owner's browser here directly, with no
// Tavzio session) - the state param is what ties this back to a real
// business, not an auth header.
const oauthCallback = asyncHandler(async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send('Missing code or state from Zoho');

  let businessId;
  try {
    ({ businessId } = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')));
  } catch {
    return res.status(400).send('Invalid state parameter');
  }

  const tokenResult = await exchangeCodeForTokens({ accountsUrl: ZOHO_ACCOUNTS_URL, code });
  if (!tokenResult.success) return res.status(400).send(`Zoho Books connection failed: ${tokenResult.error}`);

  const orgResult = await listOrganizations({ apiDomain: tokenResult.apiDomain, accessToken: tokenResult.accessToken });
  if (!orgResult.success || orgResult.organizations.length === 0) {
    return res.status(400).send('Could not find a Zoho Books organization on that account');
  }
  const zohoOrg = orgResult.organizations[0];

  const { error } = await supabaseAdmin.from('zoho_books_integrations').upsert({
    business_id: businessId,
    access_token: encryptString(tokenResult.accessToken),
    refresh_token: encryptString(tokenResult.refreshToken),
    api_domain: tokenResult.apiDomain,
    accounts_url: ZOHO_ACCOUNTS_URL,
    zoho_organization_id: zohoOrg.organization_id,
    token_expires_at: new Date(Date.now() + tokenResult.expiresInSeconds * 1000).toISOString(),
  }, { onConflict: 'business_id' });
  if (error) return res.status(400).send(`Could not save Zoho Books connection: ${error.message}`);

  // Plain redirect back into the dashboard - the owner just approved a
  // real Zoho consent screen, so landing them back on Credentials with
  // a success flag closes the loop without any extra click.
  res.redirect(`${process.env.FRONTEND_URL || ''}/admin/dashboard/settings/credentials?zohoConnected=1`);
});

async function getValidAccessToken(supabase, businessId) {
  const { data: integration } = await supabase.from('zoho_books_integrations').select('*').eq('business_id', businessId).maybeSingle();
  if (!integration) return { success: false, error: 'Zoho Books is not connected for this business' };

  // Decrypt immediately after fetch, same rule as every credential read
  // elsewhere in this codebase - everything downstream (both branches
  // below) works with real plaintext tokens from this point on, never
  // the encrypted blob.
  const decryptedRefreshToken = decryptString(integration.refresh_token);

  if (new Date(integration.token_expires_at).getTime() > Date.now() + 60000) {
    return { success: true, integration: { ...integration, access_token: decryptString(integration.access_token), refresh_token: decryptedRefreshToken } };
  }

  const refreshed = await refreshAccessToken({ accountsUrl: integration.accounts_url, refreshToken: decryptedRefreshToken });
  if (!refreshed.success) return refreshed;

  await supabase.from('zoho_books_integrations').update({
    access_token: encryptString(refreshed.accessToken),
    token_expires_at: new Date(Date.now() + refreshed.expiresInSeconds * 1000).toISOString(),
  }).eq('business_id', businessId);

  return { success: true, integration: { ...integration, access_token: refreshed.accessToken, refresh_token: decryptedRefreshToken } };
}

const getStatus = asyncHandler(async (req, res) => {
  const { data } = await req.supabase.from('zoho_books_integrations').select('connected_at, zoho_organization_id').eq('business_id', req.params.businessId).maybeSingle();
  res.json({ connected: !!data, connectedAt: data?.connected_at || null });
});

const disconnect = asyncHandler(async (req, res) => {
  await req.supabase.from('zoho_books_integrations').delete().eq('business_id', req.params.businessId);
  res.json({ message: 'Zoho Books disconnected' });
});

// @route POST /api/businesses/:businessId/zoho-books/sync
// Pushes every not-yet-synced billing receipt for this business as a
// Zoho Books Bill against the Tavzio vendor contact (created on first
// sync if it doesn't already exist).
const syncReceipts = asyncHandler(async (req, res) => {
  const tokenResult = await getValidAccessToken(req.supabase, req.params.businessId);
  if (!tokenResult.success) return res.status(400).json({ message: tokenResult.error });
  const integration = tokenResult.integration;

  const { data: legalNameRow } = await req.supabase.from('receipt_branding').select('legal_name').limit(1).maybeSingle();
  const legalName = legalNameRow?.legal_name || 'Tavzio';

  let vendorContactId = integration.vendor_contact_id;
  if (!vendorContactId) {
    const vendorResult = await findOrCreateTavzioVendorContact({
      apiDomain: integration.api_domain, accessToken: integration.access_token,
      organizationId: integration.zoho_organization_id, legalName,
    });
    if (!vendorResult.success) return res.status(400).json({ message: vendorResult.error });
    vendorContactId = vendorResult.contactId;
    await req.supabase.from('zoho_books_integrations').update({ vendor_contact_id: vendorContactId }).eq('business_id', req.params.businessId);
  }

  const { data: alreadySynced } = await req.supabase.from('zoho_books_synced_receipts').select('receipt_id').eq('business_id', req.params.businessId);
  const syncedIds = new Set((alreadySynced || []).map((r) => r.receipt_id));

  const { data: receipts } = await req.supabase.from('receipts').select('*').eq('business_id', req.params.businessId).eq('status', 'issued');
  const toSync = (receipts || []).filter((r) => !syncedIds.has(r.id));

  let synced = 0;
  const errors = [];
  for (const receipt of toSync) {
    const billResult = await createBillFromReceipt({
      apiDomain: integration.api_domain, accessToken: integration.access_token,
      organizationId: integration.zoho_organization_id, vendorContactId, receipt,
    });
    if (billResult.success) {
      await req.supabase.from('zoho_books_synced_receipts').insert({
        receipt_id: receipt.id, business_id: req.params.businessId, zoho_bill_id: billResult.data.bill.bill_id,
      });
      synced += 1;
    } else {
      errors.push({ receiptNumber: receipt.receipt_number, error: billResult.error });
    }
  }

  res.json({ message: `Synced ${synced} of ${toSync.length} receipt(s)`, synced, total: toSync.length, errors });
});

module.exports = { getConnectUrl, oauthCallback, getStatus, disconnect, syncReceipts };

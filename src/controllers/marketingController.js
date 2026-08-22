const asyncHandler = require('../utils/asyncHandler');
const { sendMail } = require('../utils/notifications');

async function requireMarketingFeature(req, res) {
  const { data: business } = await req.supabase.from('businesses').select('features, category').eq('id', req.params.businessId).single();
  if (!business?.features?.marketing?.enabled) {
    res.status(403).json({ message: 'Marketing is not enabled for this business - turn it on in Features first.' });
    return null;
  }
  return business;
}

// --- Templates ---

const listTemplates = asyncHandler(async (req, res) => {
  if (!(await requireMarketingFeature(req, res))) return;
  const { data, error } = await req.supabase.from('marketing_templates').select('*').eq('business_id', req.params.businessId).order('created_at', { ascending: false });
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

const createTemplate = asyncHandler(async (req, res) => {
  if (!(await requireMarketingFeature(req, res))) return;
  const { name, channel, subject = '', body, category = 'general' } = req.body;
  if (!name || !channel || !body) return res.status(400).json({ message: 'name, channel, and body are required' });
  if (!['email', 'sms'].includes(channel)) return res.status(400).json({ message: 'channel must be email or sms' });
  const { data, error } = await req.supabase
    .from('marketing_templates')
    .insert({ business_id: req.params.businessId, name, channel, subject, body, category })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

const deleteTemplate = asyncHandler(async (req, res) => {
  if (!(await requireMarketingFeature(req, res))) return;
  const { error, count } = await req.supabase.from('marketing_templates').delete({ count: 'exact' }).eq('id', req.params.templateId).eq('business_id', req.params.businessId);
  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Template not found' });
  res.json({ message: 'Template deleted' });
});

// --- Campaigns ---

const listCampaigns = asyncHandler(async (req, res) => {
  if (!(await requireMarketingFeature(req, res))) return;
  const { data, error } = await req.supabase.from('marketing_campaigns').select('*').eq('business_id', req.params.businessId).order('created_at', { ascending: false });
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/marketing/campaigns
// Body: { name, channel, subject, body, scheduledFor, audience: 'all_hotel_guests' | 'all_loyalty_members' | 'manual', manualContacts: [{ name, contactValue }] }
// Building the recipient list is the real work here - pulls from
// hotel_guests OR the loyalty membership table depending on which
// audience is picked (this business may only have one of the two,
// which is why it's an explicit choice rather than an auto-detect),
// and always excludes anything on marketing_suppressions.
const createCampaign = asyncHandler(async (req, res) => {
  const business = await requireMarketingFeature(req, res);
  if (!business) return;
  const { name, channel, subject = '', body, scheduledFor = null, audience = 'manual', manualContacts = [] } = req.body;
  if (!name || !channel || !body) return res.status(400).json({ message: 'name, channel, and body are required' });
  if (!['email', 'sms'].includes(channel)) return res.status(400).json({ message: 'channel must be email or sms' });
  if (!['all_hotel_guests', 'all_loyalty_members', 'manual'].includes(audience)) {
    return res.status(400).json({ message: 'audience must be all_hotel_guests, all_loyalty_members, or manual' });
  }

  const { data: campaign, error: campaignError } = await req.supabase
    .from('marketing_campaigns')
    .insert({ business_id: req.params.businessId, name, channel, subject, body, scheduled_for: scheduledFor, status: scheduledFor ? 'scheduled' : 'draft', created_by: req.user.id })
    .select()
    .single();
  if (campaignError) return res.status(400).json({ message: campaignError.message });

  const contactField = channel === 'email' ? 'email' : 'phone';
  let recipients = [];

  if (audience === 'all_hotel_guests') {
    const { data: guests } = await req.supabase.from('hotel_guests').select(`id, name, ${contactField}`).eq('business_id', req.params.businessId).not(contactField, 'eq', '');
    recipients = (guests || []).map((g) => ({ recipient_type: 'hotel_guest', recipient_ref: g.id, contact_value: g[contactField] }));
  } else if (audience === 'all_loyalty_members') {
    // customers only carries phone (loyalty is phone-identified, see
    // 0002_loyalty.sql) - there is no email on file for loyalty members,
    // so an email campaign targeting this audience has nothing to send to.
    if (channel === 'email') {
      return res.status(400).json({ message: 'Loyalty members are identified by phone only - use SMS for this audience.' });
    }
    const { data: members } = await req.supabase
      .from('loyalty_memberships')
      .select('id, customers(phone)')
      .eq('business_id', req.params.businessId);
    recipients = (members || [])
      .filter((m) => m.customers?.phone)
      .map((m) => ({ recipient_type: 'loyalty_member', recipient_ref: m.id, contact_value: m.customers.phone }));
  } else {
    recipients = (manualContacts || [])
      .filter((c) => c.contactValue)
      .map((c) => ({ recipient_type: 'manual', recipient_ref: null, contact_value: c.contactValue }));
  }

  const { data: suppressed } = await req.supabase.from('marketing_suppressions').select('contact_value').eq('business_id', req.params.businessId).eq('channel', channel);
  const suppressedSet = new Set((suppressed || []).map((s) => s.contact_value));
  const filtered = recipients.filter((r) => r.contact_value && !suppressedSet.has(r.contact_value));

  let inserted = [];
  if (filtered.length > 0) {
    const rows = filtered.map((r) => ({ campaign_id: campaign.id, business_id: req.params.businessId, ...r }));
    const { data, error } = await req.supabase.from('marketing_campaign_recipients').insert(rows).select();
    if (error) return res.status(400).json({ message: error.message });
    inserted = data;
  }

  res.status(201).json({ ...campaign, recipientCount: inserted.length, suppressedCount: recipients.length - filtered.length });
});

// @route POST /api/businesses/:businessId/marketing/campaigns/:campaignId/send
// Real send for email (via the same Gmail API sender already used for
// every other transactional email in this codebase - see
// utils/notifications.js's header for why Gmail API over SMTP). SMS is
// intentionally NOT sent here - there is no SMS provider (Twilio or
// otherwise) anywhere in this codebase and no credentials to send one
// with, so an SMS campaign is built, staged, and its recipients listed,
// but sendCampaign refuses to mark them 'sent' - it would be a lie.
// Adding real SMS requires picking a provider, getting an account, and
// wiring its API key in - that's a deliberate step for you to take, not
// something to fake here.
const sendCampaign = asyncHandler(async (req, res) => {
  if (!(await requireMarketingFeature(req, res))) return;
  const { data: campaign } = await req.supabase.from('marketing_campaigns').select('*').eq('id', req.params.campaignId).eq('business_id', req.params.businessId).single();
  if (!campaign) return res.status(404).json({ message: 'Campaign not found' });
  if (!['draft', 'scheduled'].includes(campaign.status)) return res.status(400).json({ message: 'Campaign has already been sent or cancelled' });

  if (campaign.channel === 'sms') {
    return res.status(400).json({ message: 'SMS sending isn\'t connected yet - no SMS provider is configured for this account. Email campaigns can be sent now.' });
  }

  await req.supabase.from('marketing_campaigns').update({ status: 'sending' }).eq('id', req.params.campaignId);

  const { data: recipients } = await req.supabase.from('marketing_campaign_recipients').select('id, contact_value').eq('campaign_id', req.params.campaignId).eq('status', 'pending');
  const now = new Date().toISOString();
  let sentCount = 0;
  let failedCount = 0;

  // Sent sequentially, not in parallel - Gmail API sends are already
  // being used for transactional mail elsewhere; a burst of 500
  // simultaneous campaign sends could contend with those and risk
  // hitting Gmail's per-second send-rate limit. Slower, but doesn't
  // risk transactional email (receipts, password resets) getting
  // delayed behind a marketing blast.
  // Note: sendMail() is fire-and-forget by design (see its header comment
  // in utils/notifications.js) - it logs failures server-side but never
  // throws, so this loop can't distinguish a real delivery failure from
  // success at the HTTP layer. That's the same behavior every other email
  // in this codebase already has (receipts, password resets, etc.) - 'sent'
  // here means 'handed to Gmail's API without error', not 'confirmed
  // delivered'. Genuine per-recipient delivery/bounce tracking would need
  // Gmail push notifications or a different provider with webhooks.
  for (const r of recipients || []) {
    await sendMail({ to: r.contact_value, subject: campaign.subject || campaign.name, text: campaign.body });
    await req.supabase.from('marketing_campaign_recipients').update({ status: 'sent', sent_at: now }).eq('id', r.id);
    sentCount += 1;
  }

  const { data, error } = await req.supabase.from('marketing_campaigns').update({ status: 'sent', sent_at: now }).eq('id', req.params.campaignId).select().single();
  if (error) return res.status(400).json({ message: error.message });
  res.json({ ...data, recipientsSent: sentCount, recipientsFailed: failedCount });
});

const cancelCampaign = asyncHandler(async (req, res) => {
  if (!(await requireMarketingFeature(req, res))) return;
  const { data, error } = await req.supabase
    .from('marketing_campaigns')
    .update({ status: 'cancelled' })
    .eq('id', req.params.campaignId)
    .eq('business_id', req.params.businessId)
    .in('status', ['draft', 'scheduled'])
    .select()
    .single();
  if (error || !data) return res.status(404).json({ message: 'Campaign not found or already sent' });
  res.json(data);
});

const getCampaignStats = asyncHandler(async (req, res) => {
  if (!(await requireMarketingFeature(req, res))) return;
  const { data, error } = await req.supabase.from('marketing_campaign_recipients').select('status').eq('campaign_id', req.params.campaignId).eq('business_id', req.params.businessId);
  if (error) return res.status(400).json({ message: error.message });
  const counts = {};
  for (const r of data || []) counts[r.status] = (counts[r.status] || 0) + 1;
  res.json({ total: (data || []).length, byStatus: counts });
});

// --- Suppression list ---

const listSuppressions = asyncHandler(async (req, res) => {
  if (!(await requireMarketingFeature(req, res))) return;
  const { data, error } = await req.supabase.from('marketing_suppressions').select('*').eq('business_id', req.params.businessId).order('created_at', { ascending: false });
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/marketing/suppressions
// Body: { contactValue, channel, reason }
// Also used by a public unsubscribe link handler (not built here - that
// would be a public, unauthenticated route) to record the opt-out.
const addSuppression = asyncHandler(async (req, res) => {
  if (!(await requireMarketingFeature(req, res))) return;
  const { contactValue, channel, reason = 'unsubscribed' } = req.body;
  if (!contactValue || !channel) return res.status(400).json({ message: 'contactValue and channel are required' });
  const { data, error } = await req.supabase
    .from('marketing_suppressions')
    .upsert({ business_id: req.params.businessId, contact_value: contactValue, channel, reason }, { onConflict: 'business_id,contact_value,channel' })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

const removeSuppression = asyncHandler(async (req, res) => {
  if (!(await requireMarketingFeature(req, res))) return;
  const { error, count } = await req.supabase.from('marketing_suppressions').delete({ count: 'exact' }).eq('id', req.params.suppressionId).eq('business_id', req.params.businessId);
  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Suppression entry not found' });
  res.json({ message: 'Removed from suppression list' });
});

module.exports = {
  listTemplates, createTemplate, deleteTemplate,
  listCampaigns, createCampaign, sendCampaign, cancelCampaign, getCampaignStats,
  listSuppressions, addSuppression, removeSuppression,
};

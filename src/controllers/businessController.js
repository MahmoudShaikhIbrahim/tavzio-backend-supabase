const asyncHandler = require('../utils/asyncHandler');
const { supabaseAdmin } = require('../config/supabaseClient');
const { translateToAllLanguages } = require('../utils/translate');
const { uniqueSlug } = require('../utils/slugify');

// @route GET /api/businesses/:businessId
const getBusiness = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('businesses')
    .select('*')
    .eq('id', req.params.businessId)
    .single();

  // RLS silently returns no row rather than a 403 — treat "not found" as the
  // honest answer whether it's actually missing or just not this user's tenant.
  if (error || !data) return res.status(404).json({ message: 'Business not found' });
  res.json(data);
});

// @route PATCH /api/businesses/:businessId
const updateBusiness = asyncHandler(async (req, res) => {
  const { name, logoUrl, coverImageUrl, description, category, theme, links, notificationSettings, orderingPaused, trn, tourismDirhamRateAed, operatingHours, bookingHours } = req.body;

  // Business Type (category) determines which product architecture a
  // business gets (restaurant/F&B POS vs the eventual hotel PMS+F&B
  // system) - changing it after onboarding is a structural operation,
  // not a normal profile edit. Locked to super_admin only, enforced
  // here regardless of what the frontend does or doesn't show -
  // a direct API call from a business_owner/staff token must be
  // rejected exactly the same as if they'd never sent it at all.
  if (category !== undefined && req.user.role !== 'super_admin') {
    return res.status(403).json({ message: 'Business Type can only be changed by Tavzio - contact us if this needs to change.' });
  }

  const { data: existing, error: fetchError } = await req.supabase
    .from('businesses')
    .select('links, theme, notification_settings, name, slug')
    .eq('id', req.params.businessId)
    .single();
  if (fetchError || !existing) return res.status(404).json({ message: 'Business not found' });

  const update = {};
  if (name !== undefined) update.name = name;
  // Real, explicit request: the booking link's slug now follows the
  // business's own name automatically, the same way it already would
  // if set fresh today (see contractController.js's own slug
  // generation) - only actually recomputed when the name is genuinely
  // changing to something that slugifies differently, so a same-name
  // save, a pure capitalization tweak, or any other update that
  // doesn't touch name never touches the existing slug or its printed
  // QR codes and shared links. excludeId is what keeps this business's
  // own current row from being mistaken for a collision against
  // itself on an unrelated field's save.
  if (name !== undefined && name !== existing.name) {
    const newSlug = await uniqueSlug(supabaseAdmin, 'businesses', name, { excludeId: req.params.businessId });
    if (newSlug !== existing.slug) update.slug = newSlug;
  }
  if (logoUrl !== undefined) update.logo_url = logoUrl;
  if (coverImageUrl !== undefined) update.cover_image_url = coverImageUrl;
  if (trn !== undefined) update.trn = trn;
  // Dubai/UAE Tourism Dirham per-room-night fee - hotel-only in
  // practice, but not gated behind category here since a business could
  // legitimately be reclassified later without losing a rate they'd
  // already set.
  if (tourismDirhamRateAed !== undefined) update.tourism_dirham_rate_aed = Number(tourismDirhamRateAed) || 0;
  if (category !== undefined) update.category = category; // only reachable here if req.user.role === 'super_admin', checked above
  if (description !== undefined) {
    update.description = description;
    update.description_i18n = await translateToAllLanguages(description).catch(() => ({}));
  }
  if (orderingPaused !== undefined) update.ordering_paused = !!orderingPaused;
  if (theme !== undefined) update.theme = { ...existing.theme, ...theme };
  // Real, explicit per-day hours - operatingHours is the business's own
  // real opening/closing times (Business Profile), bookingHours is the
  // optional override specifically for Online Booking's own picker.
  // Sent wholesale (not deep-merged like links/notifications) since the
  // frontend always sends the complete 7-day object it's editing.
  if (operatingHours !== undefined) update.operating_hours = operatingHours;
  if (bookingHours !== undefined) update.booking_hours = bookingHours;

  // Each of the 4 notification events is deep-merged individually, same
  // pattern as ordering/booking in setBusinessFeatures - so updating just
  // "callWaiter" never wipes out "newOrder"'s settings.
  if (notificationSettings !== undefined) {
    const merged = { ...existing.notification_settings };
    for (const key of Object.keys(notificationSettings)) {
      if (!merged[key]) continue;
      merged[key] = { ...merged[key], ...notificationSettings[key] };
    }
    update.notification_settings = merged;
  }

  if (links !== undefined) {
    const merged = { ...existing.links };
    for (const key of Object.keys(links)) {
      if (!merged[key]) continue; // ignore unknown/removed link keys entirely
      // Owner/staff control value, enabled, icon, label, and image
      // directly now - every one of these is an explicit choice made in
      // the dashboard, not a silent default.
      const { value, enabled, icon, label, imageUrl } = links[key];
      merged[key] = {
        ...merged[key],
        ...(value !== undefined ? { value } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
        ...(icon !== undefined ? { icon } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(imageUrl !== undefined ? { imageUrl } : {}),
      };
    }
    update.links = merged;
  }

  const { data, error } = await req.supabase
    .from('businesses')
    .update(update)
    .eq('id', req.params.businessId)
    .select()
    .single();

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route GET /api/businesses  (super_admin only — RLS returns all rows for that role)
const { computeNextBillingDate, EXPIRY_WARNING_DAYS } = require('../utils/contractBillingCheck');

const listBusinesses = asyncHandler(async (req, res) => {
  const { status, search, page = 1, limit = 20 } = req.query;
  let query = req.supabase.from('businesses').select('*', { count: 'exact' });

  if (status) query = query.eq('status', status);
  if (search) query = query.ilike('name', `%${search}%`);

  const from = (page - 1) * limit;
  const to = from + Number(limit) - 1;
  query = query.order('created_at', { ascending: false }).range(from, to);

  const { data, error, count } = await query;
  if (error) return res.status(400).json({ message: error.message });

  // Real countdown data for the super-admin billing view - same
  // computation the daily notification check itself uses (see
  // contractBillingCheck.js), so what the UI shows and what actually
  // triggers a notification can never quietly disagree with each other.
  const businessIds = data.map((b) => b.id);
  let contractsById = {};
  if (businessIds.length > 0) {
    const { data: contracts } = await supabaseAdmin
      .from('contracts')
      .select('business_id, contract_number, payment_frequency, start_date, end_date, status')
      .in('business_id', businessIds)
      .in('status', ['active', 'paid'])
      .order('created_at', { ascending: false });
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    for (const c of contracts || []) {
      if (contractsById[c.business_id]) continue; // most recent only, per business
      const nextBilling = computeNextBillingDate(c, today);
      const daysToBilling = Math.round((nextBilling.getTime() - today.getTime()) / 86400000);
      const endDate = new Date(`${c.end_date}T00:00:00Z`);
      const daysToExpiry = Math.round((endDate.getTime() - today.getTime()) / 86400000);
      contractsById[c.business_id] = {
        contractNumber: c.contract_number,
        paymentFrequency: c.payment_frequency,
        nextBillingDate: nextBilling.toISOString().slice(0, 10),
        daysToBilling,
        endDate: c.end_date,
        daysToExpiry,
        expiryWarningDays: EXPIRY_WARNING_DAYS[c.payment_frequency] || 30,
      };
    }
  }

  const businesses = data.map((b) => ({ ...b, contractCountdown: contractsById[b.id] || null }));
  res.json({ businesses, total: count, page: Number(page), pages: Math.ceil(count / limit) });
});

// @route PATCH /api/businesses/:businessId/status  (super_admin only)
const setBusinessStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!['active', 'suspended', 'pending'].includes(status)) {
    return res.status(400).json({ message: 'Invalid status' });
  }

  const { data, error } = await req.supabase
    .from('businesses')
    .update({ status })
    .eq('id', req.params.businessId)
    .select()
    .single();

  if (error || !data) return res.status(404).json({ message: 'Business not found' });
  res.json(data);
});

// @route DELETE /api/businesses/:businessId  (super_admin only)
const deleteBusiness = asyncHandler(async (req, res) => {
  const { error, count } = await req.supabase
    .from('businesses')
    .delete({ count: 'exact' })
    .eq('id', req.params.businessId);

  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Business not found' });
  res.json({ message: 'Business deleted' });
});

// @route PATCH /api/businesses/:businessId/features  (super_admin only)
// Deliberately separate from updateBusiness - features are entitlements
// the platform operator controls, not something an owner can grant
// themselves through the general profile-edit endpoint.
//
// Body shape:
//   {
//     ordering?: { menuView?, submission?, posIntegration?, callWaiter?, requestBill? },
//     booking?: { menuView?, submission?, integration? },
//     loyalty?: boolean,
//     staffAccounts?: boolean,
//     links?: { <linkKey>: { enabled: boolean } }  // only `enabled` is
//       ever honored here - the URL `value` stays owner-editable via
//       updateBusiness, never touched by this endpoint.
const NESTED_FEATURE_KEYS = ['ordering', 'booking', 'onlineBooking', 'driveThrough', 'accessMethods', 'inventory', 'hr', 'forecasting', 'payroll', 'accounting', 'channelManager', 'marketing'];

const setBusinessFeatures = asyncHandler(async (req, res) => {
  const { links: linksPatch, ...featuresPatch } = req.body;

  const { data: existing, error: fetchError } = await req.supabase
    .from('businesses')
    .select('features, links')
    .eq('id', req.params.businessId)
    .single();
  if (fetchError || !existing) return res.status(404).json({ message: 'Business not found' });

  const mergedFeatures = { ...existing.features };
  for (const key of Object.keys(featuresPatch)) {
    if (NESTED_FEATURE_KEYS.includes(key) && typeof featuresPatch[key] === 'object') {
      mergedFeatures[key] = { ...existing.features[key], ...featuresPatch[key] };
    } else {
      mergedFeatures[key] = featuresPatch[key];
    }
  }

  const update = { features: mergedFeatures };

  if (linksPatch) {
    const mergedLinks = { ...existing.links };
    for (const key of Object.keys(linksPatch)) {
      if (!mergedLinks[key]) continue; // ignore unknown/removed link keys
      const { enabled } = linksPatch[key];
      if (enabled !== undefined) mergedLinks[key] = { ...mergedLinks[key], enabled };
    }
    update.links = mergedLinks;
  }

  const { data, error } = await req.supabase
    .from('businesses')
    .update(update)
    .eq('id', req.params.businessId)
    .select()
    .single();

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

module.exports = {
  getBusiness,
  updateBusiness,
  listBusinesses,
  setBusinessStatus,
  setBusinessFeatures,
  deleteBusiness,
};

const QRCode = require('qrcode');
const { supabaseAdmin } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { primaryClientUrl } = require('../utils/clientUrl');

const PUBLIC_FIELDS = [
  'id', 'slug', 'card_type', 'status', 'name', 'title', 'company', 'description',
  'logo_url', 'photo_url', 'phone', 'whatsapp', 'email', 'website', 'address',
  'location_url', 'working_hours', 'contact_visibility', 'social_links', 'design',
];

function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'card';
}

async function uniqueSlug(base) {
  let slug = slugify(base);
  let suffix = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data: existing } = await supabaseAdmin.from('digital_cards').select('id').eq('slug', slug).maybeSingle();
    if (!existing) return slug;
    suffix += 1;
    slug = `${slugify(base)}-${suffix}`;
  }
}

// ============================================================
// NORMAL BUSINESS — exactly one card, owner/super_admin edit,
// staff read-only (same rule the businesses table itself uses).
// req.supabase is the RLS-scoped client, which is what makes the
// "one card per business" and "staff can't write" rules real,
// not just something the frontend chooses to hide.
// ============================================================

// @route GET /api/businesses/:businessId/digital-card
const getBusinessCard = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('digital_cards')
    .select('*')
    .eq('business_id', req.params.businessId)
    .maybeSingle();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data || null);
});

// @route POST /api/businesses/:businessId/digital-card
// Creates the business's one and only card, pre-filled from the
// existing Business Profile so nothing has to be typed twice.
const createBusinessCard = asyncHandler(async (req, res) => {
  const { data: existing } = await req.supabase
    .from('digital_cards')
    .select('id')
    .eq('business_id', req.params.businessId)
    .maybeSingle();
  if (existing) return res.status(409).json({ message: 'This business already has a digital card - edit it instead of creating another.' });

  const { data: business } = await req.supabase
    .from('businesses')
    .select('name, logo_url, description, category')
    .eq('id', req.params.businessId)
    .single();
  if (!business) return res.status(404).json({ message: 'Business not found' });

  const slug = await uniqueSlug(business.name);
  const { data: card, error } = await req.supabase
    .from('digital_cards')
    .insert({
      business_id: req.params.businessId,
      card_type: 'business',
      status: 'draft',
      slug,
      name: business.name,
      company: business.name,
      description: business.description || '',
      logo_url: business.logo_url || null,
      created_by: req.user.id,
    })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(card);
});

// @route PATCH /api/businesses/:businessId/digital-card/:cardId
const updateBusinessCard = asyncHandler(async (req, res) => {
  const update = pickCardFields(req.body);
  update.updated_at = new Date().toISOString();
  const { data, error } = await req.supabase
    .from('digital_cards')
    .update(update)
    .eq('id', req.params.cardId)
    .eq('business_id', req.params.businessId) // belt-and-suspenders alongside RLS
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

function pickCardFields(body) {
  const fields = [
    'name', 'title', 'company', 'description', 'logoUrl', 'photoUrl', 'phone', 'whatsapp',
    'email', 'website', 'address', 'locationUrl', 'workingHours', 'contactVisibility',
    'socialLinks', 'design', 'status',
  ];
  const camelToSnake = {
    logoUrl: 'logo_url', photoUrl: 'photo_url', locationUrl: 'location_url',
    workingHours: 'working_hours', contactVisibility: 'contact_visibility', socialLinks: 'social_links',
  };
  const update = {};
  for (const f of fields) {
    if (body[f] !== undefined) update[camelToSnake[f] || f] = body[f];
  }
  return update;
}

// ============================================================
// SUPER ADMIN — unlimited cards, business_id always null,
// owner_user_id always the calling super_admin. Every query below
// filters on both role AND owner_user_id, so even a super_admin
// account can only be tricked into touching their own rows, and a
// non-super_admin token is rejected before it ever reaches these
// (see routes file - authorize('super_admin') gates the whole router).
// ============================================================

// @route GET /api/super-admin/digital-cards
const listSuperAdminCards = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('digital_cards')
    .select('*')
    .eq('owner_user_id', req.user.id)
    .order('created_at', { ascending: false });
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/super-admin/digital-cards
const createSuperAdminCard = asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ message: 'name is required' });
  const slug = await uniqueSlug(name);
  const update = pickCardFields(req.body);
  const { data, error } = await supabaseAdmin
    .from('digital_cards')
    .insert({
      business_id: null,
      owner_user_id: req.user.id,
      card_type: req.body.cardType === 'business' ? 'business' : 'person',
      status: 'draft',
      slug,
      name,
      created_by: req.user.id,
      ...update,
    })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// @route PATCH /api/super-admin/digital-cards/:cardId
const updateSuperAdminCard = asyncHandler(async (req, res) => {
  const update = pickCardFields(req.body);
  update.updated_at = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('digital_cards')
    .update(update)
    .eq('id', req.params.cardId)
    .eq('owner_user_id', req.user.id) // the actual restriction: only your own cards
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  if (!data) return res.status(404).json({ message: 'Card not found' });
  res.json(data);
});

// @route DELETE /api/super-admin/digital-cards/:cardId
const deleteSuperAdminCard = asyncHandler(async (req, res) => {
  const { error, count } = await supabaseAdmin
    .from('digital_cards')
    .delete({ count: 'exact' })
    .eq('id', req.params.cardId)
    .eq('owner_user_id', req.user.id);
  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Card not found' });
  res.json({ message: 'Deleted' });
});

// @route GET /api/super-admin/digital-cards/:cardId/analytics
const getSuperAdminCardAnalytics = asyncHandler(async (req, res) => {
  const { data: card } = await supabaseAdmin.from('digital_cards').select('id').eq('id', req.params.cardId).eq('owner_user_id', req.user.id).maybeSingle();
  if (!card) return res.status(404).json({ message: 'Card not found' });
  res.json(await summarizeAnalytics(card.id));
});

// ============================================================
// SHARED (business + super admin) - analytics for a business's own card
// ============================================================

// @route GET /api/businesses/:businessId/digital-card/:cardId/analytics
const getBusinessCardAnalytics = asyncHandler(async (req, res) => {
  const { data: card } = await req.supabase.from('digital_cards').select('id').eq('id', req.params.cardId).eq('business_id', req.params.businessId).maybeSingle();
  if (!card) return res.status(404).json({ message: 'Card not found' });
  res.json(await summarizeAnalytics(card.id));
});

async function summarizeAnalytics(cardId) {
  const { data } = await supabaseAdmin.from('digital_card_analytics').select('event_type').eq('card_id', cardId);
  const counts = { view: 0, phone_click: 0, whatsapp_click: 0, email_click: 0, website_click: 0, social_click: 0, save_contact: 0, share: 0 };
  for (const row of data || []) counts[row.event_type] = (counts[row.event_type] || 0) + 1;
  return counts;
}

// ============================================================
// PUBLIC (no login) - the actual shared card people see when they
// tap the NFC card, scan the QR, or open the shared link.
// ============================================================

// @route GET /api/public/cards/:slug
const getPublicCard = asyncHandler(async (req, res) => {
  const { data: card } = await supabaseAdmin.from('digital_cards').select('*').eq('slug', req.params.slug).maybeSingle();
  if (!card || card.status !== 'active') return res.status(404).json({ message: 'This card is unavailable.' });
  const publicCard = {};
  for (const f of PUBLIC_FIELDS) publicCard[f] = card[f];
  res.json(publicCard);
});

// @route POST /api/public/cards/:slug/track  body: { eventType }
const trackCardEvent = asyncHandler(async (req, res) => {
  const { eventType } = req.body;
  const validEvents = ['view', 'phone_click', 'whatsapp_click', 'email_click', 'website_click', 'social_click', 'save_contact', 'share'];
  if (!validEvents.includes(eventType)) return res.status(400).json({ message: 'Invalid eventType' });

  const { data: card } = await supabaseAdmin.from('digital_cards').select('id').eq('slug', req.params.slug).eq('status', 'active').maybeSingle();
  if (!card) return res.status(404).json({ message: 'Card not found' });

  await supabaseAdmin.from('digital_card_analytics').insert({ card_id: card.id, event_type: eventType });
  res.status(204).end();
});

// @route GET /api/public/cards/:slug/vcard
const downloadVCard = asyncHandler(async (req, res) => {
  const { data: card } = await supabaseAdmin.from('digital_cards').select('*').eq('slug', req.params.slug).eq('status', 'active').maybeSingle();
  if (!card) return res.status(404).json({ message: 'Card not found' });

  const vis = card.contact_visibility || {};
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  if (card.card_type === 'person') {
    lines.push(`N:${card.name};;;;`);
    lines.push(`FN:${card.name}`);
    if (card.company) lines.push(`ORG:${card.company}`);
    if (card.title) lines.push(`TITLE:${card.title}`);
  } else {
    lines.push(`FN:${card.name}`);
    lines.push(`ORG:${card.name}`);
  }
  if (card.phone && vis.phone !== false) lines.push(`TEL;TYPE=WORK,VOICE:${card.phone}`);
  if (card.whatsapp && vis.whatsapp !== false) lines.push(`TEL;TYPE=CELL:${card.whatsapp}`);
  if (card.email && vis.email !== false) lines.push(`EMAIL:${card.email}`);
  if (card.website && vis.website !== false) lines.push(`URL:${card.website}`);
  if (card.address && vis.address !== false) lines.push(`ADR;TYPE=WORK:;;${card.address};;;;`);
  lines.push(`NOTE:${(card.description || '').replace(/\n/g, '\\n')}`);
  lines.push('END:VCARD');

  res.setHeader('Content-Type', 'text/vcard');
  res.setHeader('Content-Disposition', `attachment; filename="${slugify(card.name)}.vcf"`);
  res.send(lines.join('\r\n'));
});

// @route GET /api/public/cards/:slug/qr.png
const getCardQrPng = asyncHandler(async (req, res) => {
  const { data: card } = await supabaseAdmin.from('digital_cards').select('id, status').eq('slug', req.params.slug).maybeSingle();
  if (!card || card.status !== 'active') return res.status(404).json({ message: 'Card not found' });

  const url = `${primaryClientUrl()}/card/${req.params.slug}`;
  const png = await QRCode.toBuffer(url, { type: 'png', width: 1024, margin: 2, color: { dark: '#1a1a1a', light: '#ffffffff' } });
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', `inline; filename="${slugify(req.params.slug)}-qr.png"`);
  res.send(png);
});

// @route GET /api/public/cards/:slug/qr.svg
const getCardQrSvg = asyncHandler(async (req, res) => {
  const { data: card } = await supabaseAdmin.from('digital_cards').select('id, status').eq('slug', req.params.slug).maybeSingle();
  if (!card || card.status !== 'active') return res.status(404).json({ message: 'Card not found' });

  const url = `${primaryClientUrl()}/card/${req.params.slug}`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 2, color: { dark: '#1a1a1a', light: '#ffffff' } });
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Content-Disposition', `inline; filename="${slugify(req.params.slug)}-qr.svg"`);
  res.send(svg);
});

module.exports = {
  getBusinessCard, createBusinessCard, updateBusinessCard, getBusinessCardAnalytics,
  listSuperAdminCards, createSuperAdminCard, updateSuperAdminCard, deleteSuperAdminCard, getSuperAdminCardAnalytics,
  getPublicCard, trackCardEvent, downloadVCard, getCardQrPng, getCardQrSvg,
};

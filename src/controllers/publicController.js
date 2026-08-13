const { supabaseAdmin, supabasePublic } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { notifyCardUsed, sendDeviceConfirmation } = require('../utils/notifications');
const { resolveText } = require('../utils/translate');
const { maybeAutoCloseTable } = require('../utils/tableAutoClose');

function detectDevice(userAgent = '') {
  const ua = userAgent.toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return 'ios';
  if (/android/.test(ua)) return 'android';
  if (/mobile/.test(ua)) return 'other';
  return 'desktop';
}

// Every event write needs the same two pieces of anonymous context: device
// type, and the visitor's own anonymous browser-generated id (for "new vs
// returning" - never tied to a name, phone, or identity). Country/city
// geolocation was removed - IP-based location only reflects the network
// connection, not where a person is actually from, which made it useless
// for a UAE-only customer base (nearly every tap would just show "UAE").
function eventContext(req) {
  return {
    device: detectDevice(req.headers['user-agent']),
    session_id: req.headers['x-visitor-id'] || '',
  };
}

// Issues a real Supabase session for a given user via a magic-link token
// generated and exchanged server-side in the same request — never emailed,
// never shown to anyone. This works correctly regardless of whether the
// project signs JWTs with the legacy shared secret or the newer asymmetric
// keys (this project uses asymmetric ECC), since Supabase's own servers do
// the signing — we're not forging anything ourselves.
async function issueSessionFor(userId) {
  const { data: user, error: userError } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (userError || !user?.user?.email) throw new Error('Linked account could not be resolved');

  const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
    type: 'magiclink',
    email: user.user.email,
  });
  if (linkError) throw new Error(linkError.message);

  const { data: sessionData, error: verifyError } = await supabasePublic.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink',
  });
  if (verifyError) throw new Error(verifyError.message);

  return { accessToken: sessionData.session.access_token, refreshToken: sessionData.session.refresh_token, email: user.user.email };
}

// @route GET /api/public/tap/:cardUid
// Header: X-Device-Token (optional) — only relevant if
// REQUIRE_DEVICE_CONFIRMATION=true; otherwise every device skips straight
// to instant login.
const resolveCardTap = asyncHandler(async (req, res) => {
  const { data: card, error: cardError } = await supabaseAdmin
    .from('cards')
    .select('id, status, linked_user_id, business_id, room_id, merged_with_card_id, businesses(slug, status, name, features, category)')
    .eq('uid', req.params.cardUid)
    .single();

  if (cardError || !card || card.status !== 'active') {
    return res.status(404).json({ message: 'Card not found or inactive' });
  }

  const business = card.businesses;
  if (!business || business.status !== 'active') {
    return res.status(404).json({ message: 'Business not available' });
  }

  // Admin card (owner OR staff) — each card is linked to one specific
  // person's account, so an owner card and a staff card work completely
  // independently and simultaneously. Tap = instant login, always — no
  // device confirmation step by default. (That stricter mode still exists
  // in the code, just switched off — see REQUIRE_DEVICE_CONFIRMATION.)
  if (card.linked_user_id) {
    // Access-method entitlement: a business switched to website-only
    // access shouldn't have a lingering card still work, even if one was
    // issued earlier - this is a per-business, super_admin-controlled
    // toggle, checked the same way ordering/booking gate their own routes.
    if (!business.features?.accessMethods?.card) {
      return res.status(403).json({ message: 'Card access is disabled for this business. Use the website login instead.' });
    }

    const userId = card.linked_user_id;
    const requireConfirmation = process.env.REQUIRE_DEVICE_CONFIRMATION === 'true';
    const deviceToken = req.headers['x-device-token'];

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('is_active, role')
      .eq('id', userId)
      .single();
    if (!profile || !profile.is_active) {
      return res.status(403).json({ message: 'This account is inactive' });
    }

    const device = detectDevice(req.headers['user-agent']);

    let trusted = true; // default: every device is "trusted" — the simple, current behavior
    if (requireConfirmation) {
      trusted = false;
      if (deviceToken) {
        const { data } = await supabaseAdmin
          .from('trusted_devices')
          .select('id')
          .eq('user_id', userId)
          .eq('device_token', deviceToken)
          .maybeSingle();
        if (data) {
          trusted = true;
          supabaseAdmin.from('trusted_devices').update({ last_used_at: new Date().toISOString() }).eq('id', data.id).then(() => {});
        }
      }
    }

    if (trusted) {
      try {
        const { accessToken, refreshToken, email } = await issueSessionFor(userId);
        await supabaseAdmin.from('events').insert({ business_id: business.id, card_id: card.id, type: 'admin_login', ...eventContext(req) });

        if (process.env.ENABLE_ADMIN_LOGIN_ALERTS === 'true') {
          notifyCardUsed({ email, deviceLabel: device, businessName: business.name }); // fire-and-forget
        }

        return res.json({ redirect: '/admin/dashboard', role: profile.role, accessToken, refreshToken });
      } catch (err) {
        return res.status(500).json({ message: err.message });
      }
    }

    // Only reachable if REQUIRE_DEVICE_CONFIRMATION=true — the stricter
    // mode kept available for later, currently switched off by default.
    const { data: pending, error: pendingError } = await supabaseAdmin
      .from('pending_device_confirmations')
      .insert({ user_id: userId, business_id: business.id })
      .select()
      .single();
    if (pendingError) return res.status(500).json({ message: pendingError.message });

    const { data: user } = await supabaseAdmin.auth.admin.getUserById(userId);
    const confirmUrl = `${process.env.PUBLIC_BASE_URL}/admin/confirm-device/${pending.id}`;
    sendDeviceConfirmation({ email: user?.user?.email, confirmUrl, businessName: business.name });

    return res.json({
      status: 'pending_confirmation',
      message: 'New device detected — check your email to finish logging in on this device.',
      pendingConfirmationId: pending.id,
    });
  }

  // The inserted event's id is handed back as a "tap token": the frontend
  // carries it to the landing page and passes it to the loyalty check-in
  // endpoint, which is how we prove a check-in followed a real tap rather
  // than someone reloading the public URL from home.
  //
  // A merged secondary stand logs its tap event against the PRIMARY
  // card's id instead of its own - this is the one place that matters:
  // every order, bill, and table-status action downstream reads
  // tapEvent.card_id, so resolving it here means a bigger party spanning
  // two physical stands genuinely operates and counts as one table from
  // this point on, not just a cosmetic link on the floor plan.
  const effectiveCardId = card.merged_with_card_id || card.id;
  const { data: event, error: eventError } = await supabaseAdmin
    .from('events')
    .insert({
      business_id: card.business_id,
      card_id: effectiveCardId,
      type: 'nfc_tap',
      ...eventContext(req),
    })
    .select('id')
    .single();

  if (eventError) return res.status(400).json({ message: eventError.message });

  // A card placed in a hotel room routes to the guest portal instead of
  // the normal restaurant-style landing page - a fundamentally different
  // experience (room service, hotel requests, view bill) for a
  // fundamentally different kind of business, decided by Business Type
  // + whether this specific card was assigned to a room.
  if (business.category === 'hotel' && card.room_id) {
    return res.json({ redirect: `/${business.slug}/room/${card.room_id}`, tapEventId: event.id, roomId: card.room_id });
  }

  res.json({ redirect: `/${business.slug}`, tapEventId: event.id });
});

// @route GET /api/public/business/:slug
const getPublicBusiness = asyncHandler(async (req, res) => {
  const lang = req.query.lang || 'en';
  const { data: business, error } = await supabaseAdmin
    .from('businesses')
    .select('id, name, slug, logo_url, cover_image_url, description, description_i18n, links, theme, category, features')
    .eq('slug', req.params.slug)
    .eq('status', 'active')
    .single();

  if (error || !business) return res.status(404).json({ message: 'Business not found' });

  await supabaseAdmin.from('events').insert({ business_id: business.id, type: 'landing_open', ...eventContext(req) });

  // Loyalty is a separate table (richer than a simple link button), so it's
  // fetched alongside and merged into the response for the frontend's
  // convenience. `program` is null if the business hasn't enabled loyalty.
  const [{ data: program }, { data: paymentIntegration }, { data: customButtons }] = await Promise.all([
    supabaseAdmin.from('loyalty_programs').select('*').eq('business_id', business.id).eq('enabled', true).maybeSingle(),
    supabaseAdmin.from('pos_integrations').select('enabled, config').eq('business_id', business.id).eq('purpose', 'payment').eq('enabled', true).maybeSingle(),
    supabaseAdmin.from('custom_buttons').select('*').eq('business_id', business.id).eq('enabled', true).order('sort_order'),
  ]);

  res.json({
    ...business,
    description: resolveText(business.description, business.description_i18n, lang),
    loyaltyProgram: program
      ? { ...program, reward_description: resolveText(program.reward_description, program.reward_description_i18n, lang) }
      : null,
    paymentEnabled: !!paymentIntegration,
    paymentProvider: decryptConfig(paymentIntegration?.config)?.provider || 'tap',
    customButtons: (customButtons || []).map((b) => ({ ...b, label: resolveText(b.label, b.label_i18n, lang) })),
  });
});

// @route POST /api/public/business/:slug/event
const logPublicEvent = asyncHandler(async (req, res) => {
  const { type, cardUid } = req.body;

  const { data: business, error } = await supabaseAdmin
    .from('businesses')
    .select('id')
    .eq('slug', req.params.slug)
    .single();
  if (error || !business) return res.status(404).json({ message: 'Business not found' });

  let cardId = null;
  if (cardUid) {
    const { data: card } = await supabaseAdmin
      .from('cards')
      .select('id')
      .eq('uid', cardUid)
      .eq('business_id', business.id)
      .maybeSingle();
    if (card) cardId = card.id;
  }

  const { error: insertError } = await supabaseAdmin.from('events').insert({
    business_id: business.id,
    card_id: cardId,
    type,
    ...eventContext(req),
  });

  if (insertError) return res.status(400).json({ message: insertError.message });
  res.status(201).json({ message: 'Event logged' });
});

// How long a tap token stays valid for a check-in. Long enough for someone
// to actually open the page and type their number, short enough that it
// can't be reused later or shared around.
const TAP_TOKEN_VALID_MINUTES = 30;
const { calculateVatInclusive } = require('../utils/vat');
const { decryptConfig } = require('../utils/credentialEncryption');

const { getMeasure, isThresholdReady, getCurrentTier } = require('../utils/loyaltyEngine');

// Applies one tap's worth of earning to a membership and returns the
// updated fields to persist, plus the transaction to log. Spend-based
// programs are NOT earned via tap at all - a tap alone doesn't know the
// bill amount, so it just logs the visit for the record; actual spend
// amounts are added later by staff via Adjust, and tier/threshold status
// for spend programs is recomputed there instead.
function applyEarn(program, membership) {
  if (program.earn_method === 'spend') {
    return {
      update: { visits: membership.visits + 1 },
      tx: { type: 'earn_visit', amount: 0 },
      rewardReady: false,
    };
  }

  const cfg = program.config || {};
  const visits = membership.visits + 1;
  const update = { visits };
  let txType = 'earn_visit';
  let txAmount = 1;

  if (program.use_points) {
    const perVisit = cfg.pointsPerVisit || 10;
    update.points = membership.points + perVisit;
    txType = 'earn_points';
    txAmount = perVisit;
  }

  if (program.structure === 'tiered') {
    const nextMembership = { ...membership, ...update };
    const tier = getCurrentTier(program, nextMembership);
    update.current_tier = tier ? tier.name : membership.current_tier;
    return { update, tx: { type: txType, amount: txAmount }, rewardReady: false }; // tiers auto-apply at payment, never a one-time claim
  }

  const nextMembership = { ...membership, ...update };
  return { update, tx: { type: txType, amount: txAmount }, rewardReady: isThresholdReady(program, nextMembership) };
}

// @route POST /api/public/business/:slug/loyalty/checkin
// Body: { phone, tapEventId }
const loyaltyCheckin = asyncHandler(async (req, res) => {
  const { phone, tapEventId } = req.body;
  if (!phone || !tapEventId) {
    return res.status(400).json({ message: 'phone and tapEventId are required' });
  }

  const { data: business } = await supabaseAdmin
    .from('businesses')
    .select('id')
    .eq('slug', req.params.slug)
    .eq('status', 'active')
    .single();
  if (!business) return res.status(404).json({ message: 'Business not found' });

  const { data: program } = await supabaseAdmin
    .from('loyalty_programs')
    .select('*')
    .eq('business_id', business.id)
    .eq('enabled', true)
    .maybeSingle();
  if (!program) return res.status(404).json({ message: 'Loyalty program not enabled' });

  // Verify the tap token: must be a real, recent nfc_tap event for this business.
  const cutoff = new Date(Date.now() - TAP_TOKEN_VALID_MINUTES * 60 * 1000).toISOString();
  const { data: tapEvent } = await supabaseAdmin
    .from('events')
    .select('id, created_at')
    .eq('id', tapEventId)
    .eq('business_id', business.id)
    .eq('type', 'nfc_tap')
    .gte('created_at', cutoff)
    .maybeSingle();
  if (!tapEvent) {
    return res.status(400).json({ message: 'Check-in must follow a real tap, and this one has expired or is invalid' });
  }

  // find-or-create customer by phone
  let { data: customer } = await supabaseAdmin
    .from('customers')
    .select('*')
    .eq('phone', phone)
    .maybeSingle();
  if (!customer) {
    const { data: created, error: customerError } = await supabaseAdmin
      .from('customers')
      .insert({ phone })
      .select()
      .single();
    if (customerError) return res.status(400).json({ message: customerError.message });
    customer = created;
  }

  // find-or-create membership for this business
  let { data: membership } = await supabaseAdmin
    .from('loyalty_memberships')
    .select('*')
    .eq('business_id', business.id)
    .eq('customer_id', customer.id)
    .maybeSingle();
  if (!membership) {
    const { data: created, error: membershipError } = await supabaseAdmin
      .from('loyalty_memberships')
      .insert({ business_id: business.id, customer_id: customer.id })
      .select()
      .single();
    if (membershipError) return res.status(400).json({ message: membershipError.message });
    membership = created;
  }

  const { update, tx, rewardReady } = applyEarn(program, membership);

  // Cooldown: how often a tap is allowed to actually count, owner-set per
  // program. Never applies to 'spend' - that's staff-entered manually per
  // visit, not something a customer could fake by re-tapping repeatedly.
  // A rolling window (not calendar day) - simpler, no timezone edge cases.
  if (program.type !== 'spend') {
    const cooldown = program.config?.cooldown || { type: 'none' };
    const cooldownHours =
      cooldown.type === 'daily' ? 24 :
      cooldown.type === 'weekly' ? 24 * 7 :
      cooldown.type === 'custom' ? Number(cooldown.hours) || 0 :
      0;

    if (cooldownHours > 0) {
      const { data: lastEarn } = await supabaseAdmin
        .from('loyalty_transactions')
        .select('created_at')
        .eq('membership_id', membership.id)
        .in('type', ['earn_visit', 'earn_points'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (lastEarn) {
        const hoursSinceLastEarn = (Date.now() - new Date(lastEarn.created_at).getTime()) / (1000 * 60 * 60);
        if (hoursSinceLastEarn < cooldownHours) {
          // Tap acknowledged, but not credited again - return their
          // CURRENT (unchanged) status with a flag the frontend uses to
          // show "Already counted for today" instead of a credit animation.
          return res.json({ membership, rewardReady: false, alreadyCounted: true });
        }
      }
    }
  }

  // Insert the transaction FIRST — the unique index on source_event_id is
  // what actually stops a double-credit if this endpoint is called twice
  // for the same tap (e.g. a double-tap or a retried request).
  const { error: txError } = await supabaseAdmin.from('loyalty_transactions').insert({
    business_id: business.id,
    membership_id: membership.id,
    type: tx.type,
    amount: tx.amount,
    source_event_id: tapEventId,
  });
  if (txError) {
    if (txError.code === '23505') {
      return res.status(409).json({ message: 'This tap has already been credited' });
    }
    return res.status(400).json({ message: txError.message });
  }

  const { data: updatedMembership } = await supabaseAdmin
    .from('loyalty_memberships')
    .update(update)
    .eq('id', membership.id)
    .select()
    .single();

  const rewardInfo = await buildRewardInfo(program, updatedMembership);
  res.json({ membership: updatedMembership, rewardReady, alreadyCounted: false, ...rewardInfo });
});

// Shared response shaping for both loyaltyCheckin and loyaltyStatus -
// what reward (if any) this member can act on right now, structured so
// the frontend never has to interpret free text to decide what to show.
async function buildRewardInfo(program, membership) {
  if (program.structure === 'tiered') {
    const tier = getCurrentTier(program, membership);
    return {
      reward: null,
      currentTierReward: tier
        ? { name: tier.name, type: tier.rewardType, value: tier.rewardValue, description: tier.rewardDescription || '' }
        : null,
      pendingClaim: false, // tiered never uses the claim flow - applies automatically at Pay Bill
    };
  }

  const ready = isThresholdReady(program, membership);
  const { data: existingClaim } = await supabaseAdmin
    .from('loyalty_reward_claims')
    .select('id')
    .eq('membership_id', membership.id)
    .eq('status', 'pending')
    .maybeSingle();

  return {
    reward: ready ? { type: program.reward_type, value: program.reward_value, description: program.reward_description } : null,
    currentTierReward: null,
    pendingClaim: !!existingClaim,
  };
}

// @route GET /api/public/business/:slug/loyalty/status?phone=
const loyaltyStatus = asyncHandler(async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ message: 'phone is required' });

  const { data: business } = await supabaseAdmin
    .from('businesses')
    .select('id')
    .eq('slug', req.params.slug)
    .single();
  if (!business) return res.status(404).json({ message: 'Business not found' });

  const { data: customer } = await supabaseAdmin
    .from('customers')
    .select('id')
    .eq('phone', phone)
    .maybeSingle();
  if (!customer) return res.json({ membership: null });

  const { data: membership } = await supabaseAdmin
    .from('loyalty_memberships')
    .select('*')
    .eq('business_id', business.id)
    .eq('customer_id', customer.id)
    .maybeSingle();
  if (!membership) return res.json({ membership: null });

  const { data: program } = await supabaseAdmin
    .from('loyalty_programs')
    .select('*')
    .eq('business_id', business.id)
    .eq('enabled', true)
    .maybeSingle();
  if (!program) return res.json({ membership });

  const rewardInfo = await buildRewardInfo(program, membership);
  res.json({ membership, ...rewardInfo });
});

// @route POST /api/public/business/:slug/loyalty/claim
// Body: { phone, tapEventId }
// Customer taps "Claim reward" - creates a PENDING claim, tied to this
// specific table/card, for staff to see. Does NOT touch the membership's
// points/visits yet - nothing is "spent" until the claim is genuinely
// applied (bill paid, or staff marks a manual reward applied).
const claimReward = asyncHandler(async (req, res) => {
  const { phone, tapEventId } = req.body;
  if (!phone || !tapEventId) return res.status(400).json({ message: 'phone and tapEventId are required' });

  const { data: business } = await supabaseAdmin.from('businesses').select('id').eq('slug', req.params.slug).eq('status', 'active').single();
  if (!business) return res.status(404).json({ message: 'Business not found' });

  const cutoff = new Date(Date.now() - TAP_TOKEN_VALID_MINUTES * 60 * 1000).toISOString();
  const { data: tapEvent } = await supabaseAdmin
    .from('events')
    .select('id, card_id')
    .eq('id', tapEventId)
    .eq('business_id', business.id)
    .eq('type', 'nfc_tap')
    .gte('created_at', cutoff)
    .maybeSingle();
  if (!tapEvent) return res.status(400).json({ message: 'This tap has expired - tap the card again' });

  const { data: program } = await supabaseAdmin.from('loyalty_programs').select('*').eq('business_id', business.id).eq('enabled', true).maybeSingle();
  if (!program || program.structure !== 'threshold') {
    return res.status(400).json({ message: 'No claimable reward for this program' });
  }

  const { data: customer } = await supabaseAdmin.from('customers').select('id').eq('phone', phone).maybeSingle();
  const { data: membership } = customer
    ? await supabaseAdmin.from('loyalty_memberships').select('*').eq('business_id', business.id).eq('customer_id', customer.id).maybeSingle()
    : { data: null };
  if (!membership || !isThresholdReady(program, membership)) {
    return res.status(400).json({ message: 'No reward ready to claim' });
  }

  const { data: existingClaim } = await supabaseAdmin.from('loyalty_reward_claims').select('id').eq('membership_id', membership.id).eq('status', 'pending').maybeSingle();
  if (existingClaim) return res.status(400).json({ message: 'A claim is already pending for this reward' });

  let tableLabel = '';
  if (tapEvent.card_id) {
    const { data: card } = await supabaseAdmin.from('cards').select('label').eq('id', tapEvent.card_id).maybeSingle();
    tableLabel = card?.label || '';
  }

  const { data: claim, error } = await supabaseAdmin
    .from('loyalty_reward_claims')
    .insert({
      business_id: business.id,
      membership_id: membership.id,
      card_id: tapEvent.card_id,
      table_label: tableLabel,
      reward_type: program.reward_type,
      reward_value: program.reward_value,
      reward_description: program.reward_description,
    })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  res.status(201).json({ claim });
});

// @route GET /api/public/business/:slug/menu
// Only returns data if ordering.menuView is enabled - matches the RLS rule.
const getPublicMenu = asyncHandler(async (req, res) => {
  const lang = req.query.lang || 'en';
  const { data: business } = await supabaseAdmin
    .from('businesses')
    .select('id, features, ordering_paused')
    .eq('slug', req.params.slug)
    .eq('status', 'active')
    .single();
  if (!business) return res.status(404).json({ message: 'Business not found' });
  if (!business.features?.ordering?.menuView) {
    return res.status(404).json({ message: 'Ordering is not available for this business' });
  }

  const [{ data: categories }, { data: items }] = await Promise.all([
    supabaseAdmin.from('menu_categories').select('*').eq('business_id', business.id).order('sort_order'),
    // No longer filtered to is_available=true - unavailable items now
    // stay visible on the customer side (grayed out, can't be ordered)
    // rather than disappearing entirely.
    supabaseAdmin.from('menu_items').select('*').eq('business_id', business.id).order('sort_order'),
  ]);

  // Attach each item's add-ons, if it has any - one extra query rather
  // than N, since menu sizes are small enough this is never a concern.
  const itemIds = (items || []).map((i) => i.id);
  let addonsByItem = {};
  if (itemIds.length > 0) {
    const { data: addons } = await supabaseAdmin
      .from('menu_item_addons')
      .select('*')
      .in('menu_item_id', itemIds)
      .order('sort_order');
    addonsByItem = (addons || []).reduce((acc, a) => {
      (acc[a.menu_item_id] ||= []).push(a);
      return acc;
    }, {});
  }
  const now = new Date();
  const activeOfferItems = (items || []).filter(
    (i) => i.offer_price != null && i.offer_starts_at && i.offer_ends_at
      && new Date(i.offer_starts_at) <= now && now <= new Date(i.offer_ends_at)
  );

  const itemsWithAddons = (items || []).map((i) => ({
    ...i,
    name: resolveText(i.name, i.name_i18n, lang),
    description: resolveText(i.description, i.description_i18n, lang),
    addons: addonsByItem[i.id] || [],
  }));
  const translatedCategories = (categories || []).map((c) => ({
    ...c,
    name: resolveText(c.name, c.name_i18n, lang),
  }));

  // Prepended so it's always the first thing a customer sees - a virtual
  // category with a fixed id that never collides with a real one, built
  // fresh on every request from whatever's currently active. No item
  // "belongs" here in the database; it's just a filtered, re-priced view
  // of items that live in their real categories the whole time.
  if (activeOfferItems.length > 0) {
    translatedCategories.unshift({ id: '__special_offers__', business_id: business.id, name: 'Special Offers', sort_order: -1, paused: false });
  }
  const itemsForResponse = itemsWithAddons.map((i) => {
    const onOffer = activeOfferItems.some((o) => o.id === i.id);
    return onOffer
      ? [{ ...i, category_id: '__special_offers__', original_price: i.price, price: i.offer_price }, i]
      : [i];
  }).flat();

  // Tells the frontend whether this is a read-only menu (menuView on,
  // submission off - browse only, no cart) or the full cart flow.
  res.json({
    categories: translatedCategories,
    items: itemsForResponse,
    orderingPaused: !!business.ordering_paused,
    submissionEnabled: !!business.features?.ordering?.submission,
    callWaiterEnabled: !!business.features?.ordering?.callWaiter,
    requestBillEnabled: !!business.features?.ordering?.requestBill,
    payBeforeOrderEnabled: !!business.features?.ordering?.payBeforeOrder,
  });
});

// @route POST /api/public/business/:slug/orders
// Body: { tapEventId, note, items, requestType }
// `requestType` defaults to 'order' (needs items). 'call_waiter' and
// 'request_bill' are lightweight quick requests with no items - they
// reuse the same table and the same live Orders screen rather than being
// a separate system, and are gated by their OWN feature flags, not
// ordering.submission (a business could allow Call Waiter without full
// menu ordering, in principle, though in practice both usually go together).
const submitOrder = asyncHandler(async (req, res) => {
  const { tapEventId, note, items, requestType = 'order' } = req.body;
  if (!tapEventId) {
    return res.status(400).json({ message: 'tapEventId is required' });
  }
  if (requestType === 'order' && (!Array.isArray(items) || items.length === 0)) {
    return res.status(400).json({ message: 'At least one item is required' });
  }

  const { data: business } = await supabaseAdmin
    .from('businesses')
    .select('id, features, ordering_paused')
    .eq('slug', req.params.slug)
    .eq('status', 'active')
    .single();
  if (!business) return res.status(404).json({ message: 'Business not found' });

  if (requestType === 'order' && business.ordering_paused) {
    return res.status(400).json({ message: 'Ordering is currently paused' });
  }

  const featureFlag =
    requestType === 'call_waiter' ? business.features?.ordering?.callWaiter :
    requestType === 'request_bill' ? business.features?.ordering?.requestBill :
    business.features?.ordering?.submission;
  if (!featureFlag) {
    return res.status(404).json({ message: 'This request type is not available for this business' });
  }

  // Verify the tap token: must be a real, recent nfc_tap event for this
  // business, and pull the card straight off that event.
  const cutoff = new Date(Date.now() - TAP_TOKEN_VALID_MINUTES * 60 * 1000).toISOString();
  const { data: tapEvent } = await supabaseAdmin
    .from('events')
    .select('id, card_id')
    .eq('id', tapEventId)
    .eq('business_id', business.id)
    .eq('type', 'nfc_tap')
    .gte('created_at', cutoff)
    .maybeSingle();
  if (!tapEvent) {
    return res.status(400).json({ message: 'Requests must follow a real tap, and this one has expired or is invalid' });
  }

  let tableLabel = '';
  if (tapEvent.card_id) {
    const { data: card } = await supabaseAdmin.from('cards').select('label').eq('id', tapEvent.card_id).maybeSingle();
    tableLabel = card?.label || '';
  }

  let orderItemRows = [];
  let total = 0;

  if (requestType === 'order') {
    // Look up each item server-side - never trust client-submitted prices.
    const menuItemIds = items.map((i) => i.menuItemId);
    const { data: menuItems } = await supabaseAdmin
      .from('menu_items')
      .select('id, name, price, category_id')
      .in('id', menuItemIds)
      .eq('business_id', business.id)
      .eq('is_available', true);

    if (!menuItems || menuItems.length !== menuItemIds.length) {
      return res.status(400).json({ message: 'One or more items are no longer available' });
    }

    // Same check as the individual is_available flag, but for the
    // category-wide pause toggle - a paused category should reject a
    // stale order just as firmly as a sold-out single item would.
    const categoryIds = [...new Set(menuItems.map((m) => m.category_id).filter(Boolean))];
    if (categoryIds.length > 0) {
      const { data: pausedCategories } = await supabaseAdmin
        .from('menu_categories')
        .select('id')
        .in('id', categoryIds)
        .eq('paused', true);
      if (pausedCategories && pausedCategories.length > 0) {
        return res.status(400).json({ message: 'One or more items are no longer available' });
      }
    }

    // Look up every requested add-on server-side too - never trust a
    // client-submitted price for these any more than the base item itself.
    const allAddonIds = items.flatMap((i) => i.addonIds || []);
    let addonsById = {};
    if (allAddonIds.length > 0) {
      const { data: addons } = await supabaseAdmin.from('menu_item_addons').select('id, name, price').in('id', allAddonIds);
      addonsById = Object.fromEntries((addons || []).map((a) => [a.id, a]));
    }

    const menuItemsById = Object.fromEntries(menuItems.map((m) => [m.id, m]));
    orderItemRows = items.map((i) => {
      const menuItem = menuItemsById[i.menuItemId];
      const selectedAddons = (i.addonIds || []).map((id) => addonsById[id]).filter(Boolean);
      const addonTotal = selectedAddons.reduce((sum, a) => sum + Number(a.price), 0);
      return {
        menu_item_id: menuItem.id,
        item_name: menuItem.name,
        unit_price: menuItem.price,
        quantity: Math.max(1, Number(i.quantity) || 1),
        note: i.note || '',
        addons: selectedAddons.map((a) => ({ name: a.name, price: a.price })),
        addon_total: addonTotal,
      };
    });
    total = orderItemRows.reduce((sum, i) => sum + (i.unit_price + i.addon_total) * i.quantity, 0);

    // Inventory (Tier 2) - only checked if the business has turned it
    // on. blockOrdersOnLowStock defaults true, but a business can allow
    // orders through anyway and just track the shortfall.
    if (business.features?.inventory?.enabled) {
      const { checkStockAvailability } = require('../utils/inventoryStock');
      const stockCheck = await checkStockAvailability({ orderItemRows });
      if (!stockCheck.ok && business.features.inventory.blockOrdersOnLowStock !== false) {
        return res.status(400).json({ message: stockCheck.message });
      }
    }
  }

  // Only real food/drink orders get pushed to POS - a "call waiter" ping
  // has no business being sent to Foodics/Square as a line-item order.
  let integration = null;
  if (requestType === 'order' && business.features?.ordering?.posIntegration) {
    const { data } = await supabaseAdmin
      .from('pos_integrations')
      .select('*')
      .eq('business_id', business.id)
      .eq('purpose', 'ordering')
      .eq('enabled', true)
      .maybeSingle();
    integration = data ? { ...data, config: decryptConfig(data.config) } : data;
  }

  // Every submission is always its own separate order - deliberately, per
  // explicit decision: Kitchen needs each order genuinely distinct with
  // nothing merged, so staff can tell exactly what's new versus already
  // being worked. The Orders page groups a table's orders visually for
  // organization, but that's a display concern only - nothing here ever
  // combines two orders into one database record.
  const { data: order, error: orderError } = await supabaseAdmin
    .from('orders')
    .insert({
      business_id: business.id,
      card_id: tapEvent.card_id,
      table_label: tableLabel,
      note: note || '',
      total,
      request_type: requestType,
      source_event_id: tapEventId,
      pos_sync_status: integration ? 'pending' : 'not_applicable',
    })
    .select()
    .single();
  if (orderError) return res.status(400).json({ message: orderError.message });

  if (orderItemRows.length > 0) {
    const { error: itemsError } = await supabaseAdmin
      .from('order_items')
      .insert(orderItemRows.map((i) => ({ ...i, order_id: order.id })));
    if (itemsError) return res.status(400).json({ message: itemsError.message });
  }

  // Deduct stock now that the order genuinely exists - the earlier check
  // already confirmed availability (or blocking was off), so this is
  // just recording what actually got consumed.
  if (requestType === 'order' && business.features?.inventory?.enabled && orderItemRows.length > 0) {
    const { deductStock } = require('../utils/inventoryStock');
    deductStock({ businessId: business.id, orderItemRows, orderId: order.id }).catch(() => {});
  }

  // Push to POS if enabled - failures here never block the order from
  // existing in Tavzio (staff still see it on their own screen either way).
  if (integration) {
    const { pushOrderToPos } = require('../utils/posDispatcher');
    pushOrderToPos(integration.provider, integration.config, order, orderItemRows)
      .then(async (result) => {
        await supabaseAdmin
          .from('orders')
          .update({
            pos_sync_status: result.success ? 'synced' : 'failed',
            pos_external_id: result.externalOrderId || '',
            pos_sync_error: result.error || '',
          })
          .eq('id', order.id);
      })
      .catch(() => {}); // fire-and-forget - order already exists regardless
  }

  res.status(201).json({ order, items: orderItemRows });
});

// =========================================================================
// Pay-before-order — self-service feature (features.ordering.payBeforeOrder).
// When on, "Send order" never creates a normal `pending` order directly.
// Instead the order + its items are saved immediately (real, server-priced
// items - never trusted from the client, same rule as submitOrder above)
// but sit in `awaiting_payment`, invisible to Kitchen/Orders and never
// pushed to POS, until payment genuinely clears - by card (Tap in-page or
// a Telr/N-Genius/Ziina redirect), or by cash confirmed by staff. Mirrors
// the exact same shared-core pattern as the Pay Bill flow above
// (computeBillContext / finalizePaidBill), just for a not-yet-existing
// order instead of an already-placed one.
// =========================================================================

// Validates everything needed to accept a pre-paid order: business,
// feature flag, pause state, tap, and every item's real server-side
// price. Returns { errStatus, errMessage } on any failure - never
// creates anything itself, so a validation failure never leaves an
// orphaned row behind.
async function computeOrderCheckoutContext(slug, tapEventId, items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { errStatus: 400, errMessage: 'At least one item is required' };
  }

  const { data: business } = await supabaseAdmin
    .from('businesses')
    .select('id, features, ordering_paused')
    .eq('slug', slug)
    .eq('status', 'active')
    .single();
  if (!business) return { errStatus: 404, errMessage: 'Business not found' };

  if (business.ordering_paused) {
    return { errStatus: 400, errMessage: 'Ordering is currently paused' };
  }
  if (!business.features?.ordering?.submission || !business.features?.ordering?.payBeforeOrder) {
    return { errStatus: 404, errMessage: 'Pay-before-order is not available for this business' };
  }

  const cutoff = new Date(Date.now() - TAP_TOKEN_VALID_MINUTES * 60 * 1000).toISOString();
  const { data: tapEvent } = await supabaseAdmin
    .from('events')
    .select('id, card_id')
    .eq('id', tapEventId)
    .eq('business_id', business.id)
    .eq('type', 'nfc_tap')
    .gte('created_at', cutoff)
    .maybeSingle();
  if (!tapEvent || !tapEvent.card_id) {
    return { errStatus: 400, errMessage: 'Orders must follow a real tap, and this one has expired or is invalid' };
  }

  const { data: card } = await supabaseAdmin.from('cards').select('label').eq('id', tapEvent.card_id).maybeSingle();
  const tableLabel = card?.label || '';

  const menuItemIds = items.map((i) => i.menuItemId);
  const { data: menuItems } = await supabaseAdmin
    .from('menu_items')
    .select('id, name, price, category_id')
    .in('id', menuItemIds)
    .eq('business_id', business.id)
    .eq('is_available', true);
  if (!menuItems || menuItems.length !== menuItemIds.length) {
    return { errStatus: 400, errMessage: 'One or more items are no longer available' };
  }

  const categoryIds = [...new Set(menuItems.map((m) => m.category_id).filter(Boolean))];
  if (categoryIds.length > 0) {
    const { data: pausedCategories } = await supabaseAdmin
      .from('menu_categories')
      .select('id')
      .in('id', categoryIds)
      .eq('paused', true);
    if (pausedCategories && pausedCategories.length > 0) {
      return { errStatus: 400, errMessage: 'One or more items are no longer available' };
    }
  }

  const allAddonIds = items.flatMap((i) => i.addonIds || []);
  let addonsById = {};
  if (allAddonIds.length > 0) {
    const { data: addons } = await supabaseAdmin.from('menu_item_addons').select('id, name, price').in('id', allAddonIds);
    addonsById = Object.fromEntries((addons || []).map((a) => [a.id, a]));
  }

  const menuItemsById = Object.fromEntries(menuItems.map((m) => [m.id, m]));
  const orderItemRows = items.map((i) => {
    const menuItem = menuItemsById[i.menuItemId];
    const selectedAddons = (i.addonIds || []).map((id) => addonsById[id]).filter(Boolean);
    const addonTotal = selectedAddons.reduce((sum, a) => sum + Number(a.price), 0);
    return {
      menu_item_id: menuItem.id,
      item_name: menuItem.name,
      unit_price: menuItem.price,
      quantity: Math.max(1, Number(i.quantity) || 1),
      note: i.note || '',
      addons: selectedAddons.map((a) => ({ name: a.name, price: a.price })),
      addon_total: addonTotal,
    };
  });
  const total = orderItemRows.reduce((sum, i) => sum + (i.unit_price + i.addon_total) * i.quantity, 0);

  let integration = null;
  if (business.features?.ordering?.posIntegration) {
    const { data } = await supabaseAdmin
      .from('pos_integrations')
      .select('*')
      .eq('business_id', business.id)
      .eq('purpose', 'ordering')
      .eq('enabled', true)
      .maybeSingle();
    integration = data ? { ...data, config: decryptConfig(data.config) } : data;
  }

  // Same inventory check the normal order-submission path already does -
  // no reason a pay-before-order business should be able to charge a
  // customer for something the kitchen can't actually make.
  if (business.features?.inventory?.enabled) {
    const { checkStockAvailability } = require('../utils/inventoryStock');
    const stockCheck = await checkStockAvailability({ orderItemRows });
    if (!stockCheck.ok && business.features.inventory.blockOrdersOnLowStock !== false) {
      return { errStatus: 400, errMessage: stockCheck.message };
    }
  }

  return { business, tapEvent, tableLabel, orderItemRows, total, integration };
}

// Creates the order + items in `awaiting_payment` - real rows, real
// prices, but invisible to Kitchen/Orders and never pushed to POS until
// finalizeOrderPayment runs. Returns { order, orderItemRows } with the
// inserted item ids attached, needed to point a payment record at them.
async function createAwaitingOrder({ business, tapEvent, tableLabel, note, orderItemRows, total }) {
  const { data: order, error: orderError } = await supabaseAdmin
    .from('orders')
    .insert({
      business_id: business.id,
      card_id: tapEvent.card_id,
      table_label: tableLabel,
      note: note || '',
      total,
      request_type: 'order',
      status: 'awaiting_payment',
      source_event_id: tapEvent.id,
      pos_sync_status: 'not_applicable',
    })
    .select()
    .single();
  if (orderError) return { error: orderError };

  const { data: insertedItems, error: itemsError } = await supabaseAdmin
    .from('order_items')
    .insert(orderItemRows.map((i) => ({ ...i, order_id: order.id })))
    .select();
  if (itemsError) return { error: itemsError };

  return { order, orderItemRows: insertedItems };
}

// Everything that must happen once pre-payment has genuinely succeeded
// (verified server-side) - marks items paid, sends the order into the
// normal kitchen/orders flow, and pushes to POS if integrated. Also the
// exact function a staff cash confirmation calls, via orderController's
// recordManualPayment, so both payment paths converge on one place.
async function finalizeOrderPayment({ order, orderItemRows, integration, business }) {
  await supabaseAdmin
    .from('order_items')
    .update({ paid: true, cash_pending: false, paid_at: new Date().toISOString() })
    .eq('order_id', order.id);

  await supabaseAdmin
    .from('orders')
    .update({ status: 'pending', pos_sync_status: integration ? 'pending' : 'not_applicable' })
    .eq('id', order.id);

  // Same deduction the normal order-submission path does, just happening
  // at the moment payment clears instead of at order creation - a
  // pay-before-order order was never "sent" until now, so stock was
  // never touched until now either.
  if (business?.features?.inventory?.enabled) {
    const { deductStock } = require('../utils/inventoryStock');
    deductStock({ businessId: business.id, orderItemRows, orderId: order.id }).catch(() => {});
  }

  if (integration) {
    const { pushOrderToPos } = require('../utils/posDispatcher');
    pushOrderToPos(integration.provider, integration.config, order, orderItemRows)
      .then(async (result) => {
        await supabaseAdmin
          .from('orders')
          .update({
            pos_sync_status: result.success ? 'synced' : 'failed',
            pos_external_id: result.externalOrderId || '',
            pos_sync_error: result.error || '',
          })
          .eq('id', order.id);
      })
      .catch(() => {}); // fire-and-forget - order already exists regardless
  }
}

// Order that never got paid (cancelled or abandoned at checkout) - marked
// cancelled immediately, exactly the "no order sent to the kitchen"
// outcome, same principle as a Starbucks order that was never paid for.
async function cancelAwaitingOrder(orderId) {
  await supabaseAdmin
    .from('orders')
    .update({ status: 'cancelled' })
    .eq('id', orderId)
    .eq('status', 'awaiting_payment');
}

// @route POST /api/public/business/:slug/orders/pay
// Tap in-page flow. Body: { tapEventId, note, items, tapToken }
const payOrder = asyncHandler(async (req, res) => {
  const { tapEventId, note, items, tapToken } = req.body;
  if (!tapEventId || !tapToken) {
    return res.status(400).json({ message: 'tapEventId and tapToken are required' });
  }

  const ctx = await computeOrderCheckoutContext(req.params.slug, tapEventId, items);
  if (ctx.errStatus) return res.status(ctx.errStatus).json({ message: ctx.errMessage });
  const { business, tapEvent, tableLabel, orderItemRows: validatedRows, total, integration } = ctx;

  const { data: paymentIntegration } = await supabaseAdmin
    .from('pos_integrations')
    .select('*')
    .eq('business_id', business.id)
    .eq('purpose', 'payment')
    .eq('enabled', true)
    .maybeSingle();
  if (!paymentIntegration) return res.status(404).json({ message: 'Payment is not available for this business yet' });
  paymentIntegration.config = decryptConfig(paymentIntegration.config);

  const provider = paymentIntegration.config?.provider || 'tap';
  if (provider !== 'tap') {
    return res.status(400).json({ message: 'This business uses redirect-based payment - use the payment session flow' });
  }

  const created = await createAwaitingOrder({ business, tapEvent, tableLabel, note, orderItemRows: validatedRows, total });
  if (created.error) return res.status(400).json({ message: created.error.message });
  const { order, orderItemRows } = created;

  const { createCharge } = require('../utils/tapPaymentsAdapter');
  const result = await createCharge(paymentIntegration.config, tapToken, total, 'Tavzio order payment');

  const { data: payment, error: paymentError } = await supabaseAdmin
    .from('payments')
    .insert({
      business_id: business.id,
      card_id: tapEvent.card_id,
      order_item_ids: orderItemRows.map((i) => i.id),
      amount: total,
      tip_amount: 0,
      status: result.success ? 'completed' : 'failed',
      provider: 'tap',
      tap_charge_id: result.chargeId || '',
      failure_reason: result.error || '',
      source_event_id: tapEventId,
    })
    .select()
    .single();
  if (paymentError) return res.status(400).json({ message: paymentError.message });

  if (!result.success) {
    await cancelAwaitingOrder(order.id);
    return res.status(402).json({ message: result.error || 'Payment failed - no order was sent to the kitchen', payment });
  }

  await finalizeOrderPayment({ order, orderItemRows, integration, business });
  res.status(201).json({ order, payment });
});

// @route POST /api/public/business/:slug/orders/pay-session
// Redirect providers (Telr/N-Genius/Ziina). Body: { tapEventId, note, items }
const createOrderPaySession = asyncHandler(async (req, res) => {
  const { tapEventId, note, items } = req.body;
  if (!tapEventId) return res.status(400).json({ message: 'tapEventId is required' });

  const ctx = await computeOrderCheckoutContext(req.params.slug, tapEventId, items);
  if (ctx.errStatus) return res.status(ctx.errStatus).json({ message: ctx.errMessage });
  const { business, tapEvent, tableLabel, orderItemRows: validatedRows, total } = ctx;

  const { data: paymentIntegration } = await supabaseAdmin
    .from('pos_integrations')
    .select('*')
    .eq('business_id', business.id)
    .eq('purpose', 'payment')
    .eq('enabled', true)
    .maybeSingle();
  if (!paymentIntegration) return res.status(404).json({ message: 'Payment is not available for this business yet' });
  paymentIntegration.config = decryptConfig(paymentIntegration.config);

  const provider = paymentIntegration.config?.provider;
  if (provider !== 'telr' && provider !== 'ngenius' && provider !== 'ziina') {
    return res.status(400).json({ message: 'This business does not use redirect-based payment' });
  }

  const created = await createAwaitingOrder({ business, tapEvent, tableLabel, note, orderItemRows: validatedRows, total });
  if (created.error) return res.status(400).json({ message: created.error.message });
  const { order, orderItemRows } = created;

  const { data: payment, error: paymentError } = await supabaseAdmin
    .from('payments')
    .insert({
      business_id: business.id,
      card_id: tapEvent.card_id,
      order_item_ids: orderItemRows.map((i) => i.id),
      amount: total,
      tip_amount: 0,
      status: 'pending',
      provider,
      source_event_id: tapEventId,
    })
    .select()
    .single();
  if (paymentError) return res.status(400).json({ message: paymentError.message });

  const returnUrl = `${process.env.CLIENT_URL}/${req.params.slug}/menu?orderPaymentId=${payment.id}`;
  const adapter = provider === 'telr'
    ? require('../utils/telrAdapter')
    : provider === 'ngenius'
    ? require('../utils/ngeniusAdapter')
    : require('../utils/ziinaBillAdapter');

  const session = await adapter.createPaymentSession(paymentIntegration.config, total, 'Tavzio order payment', payment.id, returnUrl);
  if (!session.success) {
    await supabaseAdmin.from('payments').update({ status: 'failed', failure_reason: session.error || '' }).eq('id', payment.id);
    await cancelAwaitingOrder(order.id);
    return res.status(502).json({ message: session.error || 'Could not start the payment' });
  }

  await supabaseAdmin.from('payments').update({ provider_ref: session.providerRef }).eq('id', payment.id);
  res.status(201).json({ paymentId: payment.id, redirectUrl: session.redirectUrl, orderId: order.id });
});

// @route POST /api/public/business/:slug/orders/confirm-payment
// Body: { paymentId }
// Called when the customer lands back from the redirect provider's page.
// The provider's own status API is the only source of truth - which
// return URL the customer arrived on proves nothing.
const confirmOrderPayment = asyncHandler(async (req, res) => {
  const { paymentId } = req.body;
  if (!paymentId) return res.status(400).json({ message: 'paymentId is required' });

  const { data: business } = await supabaseAdmin
    .from('businesses')
    .select('id, features')
    .eq('slug', req.params.slug)
    .eq('status', 'active')
    .single();
  if (!business) return res.status(404).json({ message: 'Business not found' });

  const { data: payment } = await supabaseAdmin
    .from('payments')
    .select('*')
    .eq('id', paymentId)
    .eq('business_id', business.id)
    .maybeSingle();
  if (!payment) return res.status(404).json({ message: 'Payment not found' });

  const { data: items } = await supabaseAdmin
    .from('order_items')
    .select('*, orders!inner(*)')
    .in('id', payment.order_item_ids || []);
  const order = items?.[0]?.orders;
  if (!order) return res.status(404).json({ message: 'Order not found' });

  if (payment.status === 'completed') return res.json({ status: 'completed', order });
  if (payment.status === 'failed') {
    return res.status(402).json({ message: payment.failure_reason || 'Payment failed - no order was sent to the kitchen', status: 'failed' });
  }

  const { data: paymentIntegration } = await supabaseAdmin
    .from('pos_integrations')
    .select('*')
    .eq('business_id', business.id)
    .eq('purpose', 'payment')
    .eq('enabled', true)
    .maybeSingle();
  if (!paymentIntegration) return res.status(404).json({ message: 'Payment is not available for this business' });
  paymentIntegration.config = decryptConfig(paymentIntegration.config);

  const adapter = payment.provider === 'telr'
    ? require('../utils/telrAdapter')
    : payment.provider === 'ngenius'
    ? require('../utils/ngeniusAdapter')
    : require('../utils/ziinaBillAdapter');

  const check = await adapter.checkPaymentStatus(paymentIntegration.config, payment.provider_ref);
  if (!check.success) {
    return res.status(502).json({ message: check.error || 'Could not verify the payment yet', status: 'pending' });
  }

  if (!check.paid) {
    await supabaseAdmin.from('payments').update({ status: 'failed', failure_reason: check.statusText || 'Not authorised' }).eq('id', payment.id);
    await cancelAwaitingOrder(order.id);
    return res.status(402).json({ message: 'Payment was not completed - no order was sent to the kitchen', status: 'failed' });
  }

  await supabaseAdmin.from('payments').update({ status: 'completed' }).eq('id', payment.id);

  let integration = null;
  if (business.features?.ordering?.posIntegration) {
    const { data } = await supabaseAdmin
      .from('pos_integrations')
      .select('*')
      .eq('business_id', business.id)
      .eq('purpose', 'ordering')
      .eq('enabled', true)
      .maybeSingle();
    integration = data ? { ...data, config: decryptConfig(data.config) } : data;
  }

  const orderItemRows = items.map(({ orders: _orders, ...item }) => item);
  await finalizeOrderPayment({ order, orderItemRows, integration, business });

  res.json({ status: 'completed', order });
});

// Same reconciliation pattern as reconcilePendingBillPayments below,
// for the separate redirect-payment flow used when paying for a NEW
// order (as opposed to paying an existing bill) - a customer whose
// phone locks mid-redirect here needs the exact same recovery.
async function reconcilePendingOrderPayments() {
  const cutoff = new Date(Date.now() - RECONCILE_AFTER_MINUTES * 60000).toISOString();
  const giveUpCutoff = new Date(Date.now() - GIVE_UP_AFTER_HOURS * 3600000).toISOString();

  const { data: stuckPayments } = await supabaseAdmin
    .from('payments')
    .select('*')
    .eq('status', 'pending')
    .in('provider', ['telr', 'ngenius', 'ziina'])
    .lt('created_at', cutoff)
    .not('order_item_ids', 'is', null);

  for (const payment of stuckPayments || []) {
    if (payment.created_at < giveUpCutoff) {
      await supabaseAdmin.from('payments').update({ status: 'failed', failure_reason: 'Never confirmed - gave up after 24 hours' }).eq('id', payment.id);
      continue;
    }

    try {
      const { data: items } = await supabaseAdmin
        .from('order_items')
        .select('*, orders!inner(*)')
        .in('id', payment.order_item_ids || []);
      const order = items?.[0]?.orders;
      // Not every pending payment is an order-payment (bill-payments also
      // set order_item_ids) - if there's no matching awaiting order, this
      // one belongs to the other reconciliation job, not this one.
      if (!order || order.status !== 'awaiting_payment') continue;

      const { data: business } = await supabaseAdmin.from('businesses').select('id, features').eq('id', payment.business_id).single();
      const { data: integrationRow } = await supabaseAdmin
        .from('pos_integrations')
        .select('config')
        .eq('business_id', payment.business_id)
        .eq('purpose', 'payment')
        .eq('enabled', true)
        .maybeSingle();
      if (!integrationRow) continue;

      const config = decryptConfig(integrationRow.config);
      const adapter = payment.provider === 'telr'
        ? require('../utils/telrAdapter')
        : payment.provider === 'ngenius'
        ? require('../utils/ngeniusAdapter')
        : require('../utils/ziinaBillAdapter');

      const check = await adapter.checkPaymentStatus(config, payment.provider_ref);
      if (!check.success) continue; // transient check failure - try again next tick

      if (!check.paid) {
        await supabaseAdmin.from('payments').update({ status: 'failed', failure_reason: check.statusText || 'Not authorised' }).eq('id', payment.id);
        await cancelAwaitingOrder(order.id);
        continue;
      }

      await supabaseAdmin.from('payments').update({ status: 'completed' }).eq('id', payment.id);

      let posIntegration = null;
      if (business?.features?.ordering?.posIntegration) {
        const { data } = await supabaseAdmin
          .from('pos_integrations')
          .select('*')
          .eq('business_id', payment.business_id)
          .eq('purpose', 'ordering')
          .eq('enabled', true)
          .maybeSingle();
        posIntegration = data ? { ...data, config: decryptConfig(data.config) } : data;
      }

      const orderItemRows = items.map(({ orders: _orders, ...item }) => item);
      await finalizeOrderPayment({ order, orderItemRows, integration: posIntegration, business });
    } catch (err) {
      console.error(`Order payment reconciliation failed for payment ${payment.id}:`, err.message);
    }
  }
}
// Body: { tapEventId, note, items }
// No charge happens here - the order is created and its items flagged
// cash_pending, same flag Pay Bill's cash flow already uses, so it
// surfaces on staff's existing Cash Pending queue automatically. Staff
// confirming the cash payment (orderController.recordManualPayment) is
// what actually sends it to the kitchen.
const payOrderWithCash = asyncHandler(async (req, res) => {
  const { tapEventId, note, items } = req.body;
  if (!tapEventId) return res.status(400).json({ message: 'tapEventId is required' });

  const ctx = await computeOrderCheckoutContext(req.params.slug, tapEventId, items);
  if (ctx.errStatus) return res.status(ctx.errStatus).json({ message: ctx.errMessage });
  const { business, tapEvent, tableLabel, orderItemRows: validatedRows, total } = ctx;

  const created = await createAwaitingOrder({ business, tapEvent, tableLabel, note, orderItemRows: validatedRows, total });
  if (created.error) return res.status(400).json({ message: created.error.message });
  const { order, orderItemRows } = created;

  await supabaseAdmin
    .from('order_items')
    .update({ cash_pending: true })
    .in('id', orderItemRows.map((i) => i.id));

  res.status(201).json({ order, message: 'Please pay at the cashier' });
});

// @route POST /api/public/business/:slug/orders/:orderId/cancel-payment
// Body: { tapEventId }
// Customer explicitly backs out of checkout before paying - tap-gated so
// only the same table that placed it can cancel it, same trust boundary
// as every other public write in this file.
const cancelOrderPayment = asyncHandler(async (req, res) => {
  const { tapEventId } = req.body;
  if (!tapEventId) return res.status(400).json({ message: 'tapEventId is required' });

  const { data: order } = await supabaseAdmin
    .from('orders')
    .select('id, source_event_id')
    .eq('id', req.params.orderId)
    .eq('status', 'awaiting_payment')
    .maybeSingle();
  if (!order || String(order.source_event_id) !== String(tapEventId)) {
    return res.status(404).json({ message: 'Order not found' });
  }

  await cancelAwaitingOrder(order.id);
  res.json({ message: 'Order cancelled - nothing was sent to the kitchen' });
});

// @route GET /api/public/business/:slug/services
// Only returns data if booking.menuView is enabled.
const getPublicServices = asyncHandler(async (req, res) => {
  const { data: business } = await supabaseAdmin
    .from('businesses')
    .select('id, features')
    .eq('slug', req.params.slug)
    .eq('status', 'active')
    .single();
  if (!business) return res.status(404).json({ message: 'Business not found' });
  if (!business.features?.booking?.menuView) {
    return res.status(404).json({ message: 'Booking is not available for this business' });
  }

  const { data: services } = await supabaseAdmin
    .from('services')
    .select('*')
    .eq('business_id', business.id)
    .eq('is_available', true)
    .order('sort_order');

  res.json({ services: services || [] });
});

// @route POST /api/public/business/:slug/bookings
// Body: { tapEventId, serviceId, requestedAt, note, contactPhone }
// Same tap-gating pattern as orders. Bookings are a REQUEST, not a
// confirmed slot - staff confirm/decline from their dashboard, since this
// deliberately doesn't implement real staff-availability scheduling yet.
const submitBooking = asyncHandler(async (req, res) => {
  const { tapEventId, serviceId, requestedAt, note, contactPhone } = req.body;
  if (!tapEventId || !serviceId || !requestedAt) {
    return res.status(400).json({ message: 'tapEventId, serviceId, and requestedAt are required' });
  }

  const { data: business } = await supabaseAdmin
    .from('businesses')
    .select('id, features')
    .eq('slug', req.params.slug)
    .eq('status', 'active')
    .single();
  if (!business) return res.status(404).json({ message: 'Business not found' });
  if (!business.features?.booking?.submission) {
    return res.status(404).json({ message: 'Booking is not available for this business' });
  }

  const cutoff = new Date(Date.now() - TAP_TOKEN_VALID_MINUTES * 60 * 1000).toISOString();
  const { data: tapEvent } = await supabaseAdmin
    .from('events')
    .select('id, card_id')
    .eq('id', tapEventId)
    .eq('business_id', business.id)
    .eq('type', 'nfc_tap')
    .gte('created_at', cutoff)
    .maybeSingle();
  if (!tapEvent) {
    return res.status(400).json({ message: 'Bookings must follow a real tap, and this one has expired or is invalid' });
  }

  const { data: service } = await supabaseAdmin
    .from('services')
    .select('id, name')
    .eq('id', serviceId)
    .eq('business_id', business.id)
    .eq('is_available', true)
    .maybeSingle();
  if (!service) return res.status(400).json({ message: 'This service is no longer available' });

  let integration = null;
  if (business.features?.booking?.integration) {
    const { data } = await supabaseAdmin
      .from('pos_integrations')
      .select('*')
      .eq('business_id', business.id)
      .eq('purpose', 'booking')
      .eq('enabled', true)
      .maybeSingle();
    integration = data ? { ...data, config: decryptConfig(data.config) } : data;
  }

  const { data: booking, error: bookingError } = await supabaseAdmin
    .from('bookings')
    .insert({
      business_id: business.id,
      card_id: tapEvent.card_id,
      service_id: service.id,
      service_name: service.name,
      requested_at: requestedAt,
      note: note || '',
      contact_phone: contactPhone || '',
      source_event_id: tapEventId,
      pos_sync_status: integration ? 'pending' : 'not_applicable',
    })
    .select()
    .single();
  if (bookingError) return res.status(400).json({ message: bookingError.message });

  if (integration) {
    const { pushBookingToPos } = require('../utils/posDispatcher');
    pushBookingToPos(integration.provider, integration.config, booking)
      .then(async (result) => {
        await supabaseAdmin
          .from('bookings')
          .update({
            pos_sync_status: result.success ? 'synced' : 'failed',
            pos_external_id: result.externalOrderId || '',
            pos_sync_error: result.error || '',
          })
          .eq('id', booking.id);
      })
      .catch(() => {});
  }

  res.status(201).json({ booking });
});

// @route POST /api/public/business/:slug/bill/cash-pending
// Body: { tapEventId, itemIds }
// Customer intent only - this NEVER marks anything paid. It flags the
// selected items as "cash pending" so staff get alerted to come collect
// it, while the items stay fully visible and still payable online by
// anyone at the table in the meantime (same "whoever gets there first"
// rule as any other split-bill item). Only an explicit staff
// confirmation (via recordManualPayment, the same flow as any other
// manual settlement) actually marks something paid and clears this flag.
// This two-step design exists specifically so a customer's own tap can
// never make money disappear from tracking without a human confirming
// it actually arrived - see the cash-payment design discussion.
const markItemsCashPending = asyncHandler(async (req, res) => {
  const { tapEventId, itemIds } = req.body;
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return res.status(400).json({ message: 'No items selected' });
  }

  const { data: business } = await supabaseAdmin
    .from('businesses')
    .select('id')
    .eq('slug', req.params.slug)
    .eq('status', 'active')
    .single();
  if (!business) return res.status(404).json({ message: 'Business not found' });

  const cutoff = new Date(Date.now() - TAP_TOKEN_VALID_MINUTES * 60 * 1000).toISOString();
  const { data: tapEvent } = await supabaseAdmin
    .from('events')
    .select('id, card_id')
    .eq('id', tapEventId)
    .eq('business_id', business.id)
    .eq('type', 'nfc_tap')
    .gte('created_at', cutoff)
    .maybeSingle();
  if (!tapEvent || !tapEvent.card_id) {
    return res.status(400).json({ message: 'This session has expired - please tap again' });
  }

  const { data: orders } = await supabaseAdmin
    .from('orders')
    .select('id, order_items(id)')
    .eq('business_id', business.id)
    .eq('card_id', tapEvent.card_id)
    .eq('request_type', 'order')
    .eq('voided', false)
    .neq('status', 'cancelled');

  // Only ever flags items that genuinely belong to this table and are
  // still actually unpaid - never trusts itemIds blindly.
  const validItemIds = new Set((orders || []).flatMap((o) => o.order_items).map((i) => i.id));
  const targetIds = itemIds.filter((id) => validItemIds.has(id));
  if (targetIds.length === 0) {
    return res.status(400).json({ message: 'None of those items belong to this table' });
  }

  await supabaseAdmin
    .from('order_items')
    .update({ cash_pending: true })
    .in('id', targetIds)
    .eq('paid', false);

  res.json({ message: 'Marked as cash pending - let your server know', itemIds: targetIds });
});

// @route GET /api/public/business/:slug/bill?tapEventId=X
// Everything still unpaid at this table, across every order placed there -
// not just the most recent one. No auto-attribution by who ordered what;
// the customer picks which items they're covering on the frontend.
const getBill = asyncHandler(async (req, res) => {
  const tapEventId = Number(req.query.tapEventId);
  if (!tapEventId) return res.status(400).json({ message: 'tapEventId is required' });

  const { data: business } = await supabaseAdmin
    .from('businesses')
    .select('id')
    .eq('slug', req.params.slug)
    .eq('status', 'active')
    .single();
  if (!business) return res.status(404).json({ message: 'Business not found' });

  const cutoff = new Date(Date.now() - TAP_TOKEN_VALID_MINUTES * 60 * 1000).toISOString();
  const { data: tapEvent } = await supabaseAdmin
    .from('events')
    .select('id, card_id')
    .eq('id', tapEventId)
    .eq('business_id', business.id)
    .eq('type', 'nfc_tap')
    .gte('created_at', cutoff)
    .maybeSingle();
  if (!tapEvent || !tapEvent.card_id) {
    return res.status(400).json({ message: 'The bill must follow a real tap, and this one has expired or is invalid' });
  }

  // All unpaid, non-voided items across every active order placed from
  // this card. Voided items (stray leftovers staff have cleared) never
  // show up here - that's the actual point of voiding.
  const { data: orders } = await supabaseAdmin
    .from('orders')
    .select('id, order_items(*)')
    .eq('business_id', business.id)
    .eq('card_id', tapEvent.card_id)
    .eq('request_type', 'order')
    .eq('voided', false)
    .neq('status', 'cancelled');

  const allItems = (orders || [])
    .flatMap((o) => o.order_items.map((i) => ({ ...i, order_id: o.id })))
    .filter((i) => !i.voided);
  const items = allItems.filter((i) => !i.paid);
  // Shown in a collapsed "Paid" section on the bill page - lets any
  // diner (including whoever just paid) see what's already settled at a
  // glance without it cluttering the main payable list. Expires 10
  // minutes after payment regardless of what else happens at the table -
  // doesn't depend on auto-close's one "everything paid at once" moment,
  // which isn't guaranteed to ever occur if new items keep getting added.
  const PAID_SECTION_WINDOW_MS = 10 * 60 * 1000;
  const paidItems = allItems.filter((i) => i.paid && i.paid_at && Date.now() - new Date(i.paid_at).getTime() < PAID_SECTION_WINDOW_MS);

  const subtotal = items.reduce((sum, i) => sum + (i.unit_price + Number(i.addon_total || 0)) * i.quantity, 0);

  // Preview only - payBill recomputes this itself at the actual moment of
  // payment, this is purely so the customer sees the real total upfront.
  let discountAmount = 0;
  let rewardDescription = '';

  const { data: pendingClaim } = await supabaseAdmin
    .from('loyalty_reward_claims')
    .select('*')
    .eq('business_id', business.id)
    .eq('card_id', tapEvent.card_id)
    .eq('status', 'pending')
    .maybeSingle();

  if (pendingClaim) {
    if (pendingClaim.reward_type === 'percentage') discountAmount = Math.round(subtotal * (Number(pendingClaim.reward_value) / 100) * 100) / 100;
    else if (pendingClaim.reward_type === 'fixed_amount') discountAmount = Math.min(subtotal, Number(pendingClaim.reward_value));
    rewardDescription = pendingClaim.reward_description;
  } else if (req.query.phone) {
    const { data: program } = await supabaseAdmin.from('loyalty_programs').select('*').eq('business_id', business.id).eq('enabled', true).maybeSingle();
    if (program && program.structure === 'tiered') {
      const { data: customer } = await supabaseAdmin.from('customers').select('id').eq('phone', req.query.phone).maybeSingle();
      if (customer) {
        const { data: membership } = await supabaseAdmin.from('loyalty_memberships').select('*').eq('business_id', business.id).eq('customer_id', customer.id).maybeSingle();
        if (membership) {
          const tier = getCurrentTier(program, membership);
          if (tier && tier.rewardType !== 'manual') {
            discountAmount = tier.rewardType === 'percentage' ? Math.round(subtotal * (Number(tier.rewardValue) / 100) * 100) / 100 : Math.min(subtotal, Number(tier.rewardValue));
            rewardDescription = tier.rewardDescription || `${tier.name} tier discount`;
          }
        }
      }
    }
  }

  const total = Math.max(0, subtotal - discountAmount);
  res.json({ items, paidItems, total, subtotal, discountAmount, rewardDescription });
});

// @route POST /api/public/business/:slug/bill/pay
// Body: { tapEventId, itemIds?, tipAmount, tapToken, phone? }
// `itemIds` omitted/null means "pay everything currently unpaid" - either
// way, any customer can select any combination, including items someone
// else ordered (people cover each other's food often) - never auto-split
// by who tapped or who ordered.
// =========================================================================
// Shared bill-payment core - used by BOTH the instant Tap flow (payBill)
// and the redirect flow (createPaySession/confirmPaySession), so the
// pricing, loyalty, and receipt logic can never drift between providers.
// =========================================================================

// Everything needed to charge a bill: validates the tap, gathers unpaid
// items, applies loyalty discounts, and loads the payment integration.
// Returns { errStatus, errMessage } on any failure.
// Releases a payment reservation early on a known failure, rather than
// making the next person wait out the full 5-minute auto-expiry for a
// charge that already, definitively, didn't happen.
async function releaseItemReservation(itemIds) {
  if (!itemIds?.length) return;
  await supabaseAdmin.from('order_items').update({ payment_reserved_until: null }).in('id', itemIds);
}

async function computeBillContext(slug, tapEventId, itemIds, tipAmount, phone) {
  const { data: business } = await supabaseAdmin
    .from('businesses')
    .select('id, features')
    .eq('slug', slug)
    .eq('status', 'active')
    .single();
  if (!business) return { errStatus: 404, errMessage: 'Business not found' };

  const cutoff = new Date(Date.now() - TAP_TOKEN_VALID_MINUTES * 60 * 1000).toISOString();
  const { data: tapEvent } = await supabaseAdmin
    .from('events')
    .select('id, card_id')
    .eq('id', tapEventId)
    .eq('business_id', business.id)
    .eq('type', 'nfc_tap')
    .gte('created_at', cutoff)
    .maybeSingle();
  if (!tapEvent || !tapEvent.card_id) {
    return { errStatus: 400, errMessage: 'Payment must follow a real tap, and this one has expired or is invalid' };
  }

  const { data: orders } = await supabaseAdmin
    .from('orders')
    .select('id, order_items(*)')
    .eq('business_id', business.id)
    .eq('card_id', tapEvent.card_id)
    .eq('request_type', 'order')
    .eq('voided', false)
    .neq('status', 'cancelled');

  // An item currently reserved by someone else's in-flight payment
  // attempt is excluded here entirely, same as an already-paid item -
  // this is what stops a second customer from even seeing it as
  // selectable while the first payment is still being processed.
  const now = new Date();
  const unpaidItems = (orders || []).flatMap((o) => o.order_items)
    .filter((i) => !i.paid && !i.voided && (!i.payment_reserved_until || new Date(i.payment_reserved_until) < now));
  const selectedItems = Array.isArray(itemIds) && itemIds.length > 0
    ? unpaidItems.filter((i) => itemIds.includes(i.id))
    : unpaidItems;

  if (selectedItems.length === 0) {
    return { errStatus: 400, errMessage: 'Nothing to pay' };
  }

  // The actual fix, not just the filter above: atomically reserve
  // exactly these items, using the UPDATE's WHERE clause as the real
  // mutex (Postgres itself decides who wins, not application code
  // racing against itself). If fewer rows come back than requested,
  // someone else's payment attempt reserved at least one of them in
  // the narrow window between the read above and this write - reject
  // the whole attempt outright rather than proceed with a partial,
  // inconsistent selection.
  const reservedUntil = new Date(Date.now() + 5 * 60000).toISOString();
  const nowIso = now.toISOString();
  const { data: reserved } = await supabaseAdmin
    .from('order_items')
    .update({ payment_reserved_until: reservedUntil })
    .in('id', selectedItems.map((i) => i.id))
    .eq('paid', false)
    .or(`payment_reserved_until.is.null,payment_reserved_until.lt.${nowIso}`)
    .select('id');

  if (!reserved || reserved.length < selectedItems.length) {
    // Release whatever this attempt did manage to grab - never leave a
    // failed attempt holding a partial reservation that blocks the
    // person who actually won the race.
    if (reserved?.length) {
      await supabaseAdmin.from('order_items').update({ payment_reserved_until: null }).in('id', reserved.map((r) => r.id));
    }
    return { errStatus: 409, errMessage: 'Someone else is already paying for part of this bill - try again in a moment' };
  }

  const amount = selectedItems.reduce((sum, i) => sum + (i.unit_price + Number(i.addon_total || 0)) * i.quantity, 0);

  // --- Reward auto-application ---
  // Threshold: a claim the customer already tapped "Claim" for, tied to
  // THIS specific table - percentage/fixed amounts apply automatically;
  // a 'manual' reward (free item, etc.) has no number to subtract, so
  // staff handle it themselves and this just marks it applied for the record.
  // Tiered: an ongoing discount based on current status, applied every
  // time automatically - no claim, nothing to mark applied, never resets.
  let discountAmount = 0;
  let appliedClaim = null;

  const { data: pendingClaim } = await supabaseAdmin
    .from('loyalty_reward_claims')
    .select('*')
    .eq('business_id', business.id)
    .eq('card_id', tapEvent.card_id)
    .eq('status', 'pending')
    .maybeSingle();

  if (pendingClaim) {
    appliedClaim = pendingClaim;
    if (pendingClaim.reward_type === 'percentage') {
      discountAmount = Math.round(amount * (Number(pendingClaim.reward_value) / 100) * 100) / 100;
    } else if (pendingClaim.reward_type === 'fixed_amount') {
      discountAmount = Math.min(amount, Number(pendingClaim.reward_value));
    }
  } else if (phone) {
    const { data: program } = await supabaseAdmin.from('loyalty_programs').select('*').eq('business_id', business.id).eq('enabled', true).maybeSingle();
    if (program && program.structure === 'tiered') {
      const { data: customer } = await supabaseAdmin.from('customers').select('id').eq('phone', phone).maybeSingle();
      if (customer) {
        const { data: membership } = await supabaseAdmin.from('loyalty_memberships').select('*').eq('business_id', business.id).eq('customer_id', customer.id).maybeSingle();
        if (membership) {
          const tier = getCurrentTier(program, membership);
          if (tier && tier.rewardType !== 'manual') {
            discountAmount = tier.rewardType === 'percentage'
              ? Math.round(amount * (Number(tier.rewardValue) / 100) * 100) / 100
              : Math.min(amount, Number(tier.rewardValue));
          }
        }
      }
    }
  }

  const discountedAmount = Math.max(0, amount - discountAmount);
  const total = discountedAmount + Number(tipAmount || 0);

  const { data: integration } = await supabaseAdmin
    .from('pos_integrations')
    .select('*')
    .eq('business_id', business.id)
    .eq('purpose', 'payment')
    .eq('enabled', true)
    .maybeSingle();
  if (!integration) {
    return { errStatus: 404, errMessage: 'Payment is not available for this business yet' };
  }
  integration.config = decryptConfig(integration.config);

  return { business, tapEvent, selectedItems, amount, discountAmount, discountedAmount, appliedClaim, total, integration };
}

// Everything that must happen once a bill payment has GENUINELY succeeded
// (verified server-side, never assumed): mark items paid, apply/reset the
// loyalty claim, credit spend-based loyalty, and build the receipt.
async function finalizePaidBill({ business, payment, selectedItems, appliedClaim, discountAmount, discountedAmount, amount, tipAmount, phone, total }) {
  await supabaseAdmin
    .from('order_items')
    .update({ paid: true, cash_pending: false, paid_at: new Date().toISOString() })
    .in('id', selectedItems.map((i) => i.id));

  // The moment this specific payment might have been the last thing
  // owed on the table - checked fresh against the database rather than
  // assumed, since split-bill means other people could still owe money
  // even after this particular payment succeeds.
  await maybeAutoCloseTable(supabaseAdmin, business.id, payment.card_id);

  // A threshold reward only actually resets once it's genuinely used -
  // tapping "Claim" never touched the membership, this is the real
  // moment it's spent. Visits/points reset to 0 (not decremented by the
  // threshold), matching the existing redeem behavior - any surplus
  // beyond the exact threshold is intentionally kept, not lost.
  if (appliedClaim) {
    await supabaseAdmin.from('loyalty_reward_claims').update({ status: 'applied', applied_to_payment_id: payment.id, applied_at: new Date().toISOString() }).eq('id', appliedClaim.id);

    const { data: membershipRow } = await supabaseAdmin.from('loyalty_memberships').select('*').eq('id', appliedClaim.membership_id).maybeSingle();
    if (membershipRow) {
      const { data: claimProgram } = await supabaseAdmin.from('loyalty_programs').select('*').eq('business_id', business.id).maybeSingle();
      const resetUpdate = claimProgram?.earn_method === 'spend'
        ? { total_spend: 0 }
        : claimProgram?.use_points ? { points: 0 } : { visits: 0 };
      await supabaseAdmin.from('loyalty_memberships').update(resetUpdate).eq('id', membershipRow.id);
      await supabaseAdmin.from('loyalty_transactions').insert({
        business_id: business.id,
        membership_id: membershipRow.id,
        type: 'redeem',
        amount: discountAmount,
        note: `Reward applied at payment (${appliedClaim.reward_description || appliedClaim.reward_type})`,
      });
    }
  }

  // Optional spend-based loyalty credit - only if a phone was supplied
  // (already-recognized on this device, same pattern as auto-checkin) and
  // this business runs a spend-type program. Tip is deliberately excluded
  // from spend credit - it's not money spent on the business itself.
  if (phone && business.features?.loyalty) {
    const { data: program } = await supabaseAdmin
      .from('loyalty_programs')
      .select('*')
      .eq('business_id', business.id)
      .eq('enabled', true)
      .eq('earn_method', 'spend')
      .maybeSingle();

    if (program) {
      let { data: customer } = await supabaseAdmin.from('customers').select('*').eq('phone', phone).maybeSingle();
      if (!customer) {
        const { data: created } = await supabaseAdmin.from('customers').insert({ phone }).select().single();
        customer = created;
      }
      if (customer) {
        let { data: membership } = await supabaseAdmin
          .from('loyalty_memberships')
          .select('*')
          .eq('business_id', business.id)
          .eq('customer_id', customer.id)
          .maybeSingle();
        if (!membership) {
          const { data: created } = await supabaseAdmin
            .from('loyalty_memberships')
            .insert({ business_id: business.id, customer_id: customer.id })
            .select()
            .single();
          membership = created;
        }
        if (membership) {
          await supabaseAdmin
            .from('loyalty_memberships')
            .update({ total_spend: Number(membership.total_spend) + amount })
            .eq('id', membership.id);
          await supabaseAdmin.from('loyalty_transactions').insert({
            business_id: business.id,
            membership_id: membership.id,
            type: 'earn_spend',
            amount,
          });
        }
      }
    }
  }

  // Digital receipt - itemized with a real VAT breakdown, not just a bare
  // total. Menu prices are treated as VAT-inclusive (standard UAE
  // practice), so VAT is derived from the (post-discount) amount rather
  // than added on top. English only, per explicit decision - not run
  // through translation.
  const { subtotalExVat, vatAmount, vatRate } = calculateVatInclusive(discountedAmount);

  const receipt = {
    items: selectedItems.map((i) => ({
      name: i.item_name,
      quantity: i.quantity,
      unitPrice: i.unit_price,
      addons: i.addons || [],
      lineTotal: Math.round((i.unit_price + Number(i.addon_total || 0)) * i.quantity * 100) / 100,
    })),
    subtotalExVat,
    vatAmount,
    vatRate,
    discountAmount,
    rewardDescription: appliedClaim?.reward_description || '',
    tip: Number(tipAmount || 0),
    total,
    paidAt: payment.created_at,
    paymentId: payment.id,
  };


  return receipt;
}

const payBill = asyncHandler(async (req, res) => {
  const { tapEventId, itemIds, tipAmount = 0, tapToken, phone } = req.body;
  if (!tapEventId || !tapToken) {
    return res.status(400).json({ message: 'tapEventId and tapToken are required' });
  }

  const ctx = await computeBillContext(req.params.slug, tapEventId, itemIds, tipAmount, phone);
  if (ctx.errStatus) return res.status(ctx.errStatus).json({ message: ctx.errMessage });
  const { business, tapEvent, selectedItems, amount, discountAmount, discountedAmount, appliedClaim, total, integration } = ctx;

  // Tap is the in-page provider (Apple/Google Pay token) - a business
  // configured for a redirect provider can't take a token payment.
  const provider = integration.config?.provider || 'tap';
  if (provider !== 'tap') {
    await releaseItemReservation(selectedItems.map((i) => i.id));
    return res.status(400).json({ message: 'This business uses redirect-based payment - use the payment session flow' });
  }

  const { createCharge } = require('../utils/tapPaymentsAdapter');
  const result = await createCharge(integration.config, tapToken, total, 'Tavzio bill payment');
  if (!result.success) await releaseItemReservation(selectedItems.map((i) => i.id));

  const { data: payment, error: paymentError } = await supabaseAdmin
    .from('payments')
    .insert({
      business_id: business.id,
      card_id: tapEvent.card_id,
      order_item_ids: selectedItems.map((i) => i.id),
      amount,
      discount_amount: discountAmount,
      reward_claim_id: appliedClaim?.id || null,
      tip_amount: tipAmount || 0,
      status: result.success ? 'completed' : 'failed',
      provider: 'tap',
      tap_charge_id: result.chargeId || '',
      failure_reason: result.error || '',
      source_event_id: tapEventId,
    })
    .select()
    .single();
  if (paymentError) return res.status(400).json({ message: paymentError.message });

  if (!result.success) {
    return res.status(402).json({ message: result.error || 'Payment failed', payment });
  }

  const receipt = await finalizePaidBill({ business, payment, selectedItems, appliedClaim, discountAmount, discountedAmount, amount, tipAmount, phone, total });

  res.status(201).json({ payment, receipt });
});

// @route POST /api/public/business/:slug/bill/pay-session
// Redirect providers (Telr, N-Genius): computes the exact same bill as
// payBill would, records a 'pending' payment, and returns the provider's
// hosted page URL for the customer to pay on. Nothing is marked paid
// here - only confirmPaySession does that, after real verification.
const createPaySession = asyncHandler(async (req, res) => {
  const { tapEventId, itemIds, tipAmount = 0, phone } = req.body;
  if (!tapEventId) {
    return res.status(400).json({ message: 'tapEventId is required' });
  }

  const ctx = await computeBillContext(req.params.slug, tapEventId, itemIds, tipAmount, phone);
  if (ctx.errStatus) return res.status(ctx.errStatus).json({ message: ctx.errMessage });
  const { business, tapEvent, selectedItems, amount, discountAmount, appliedClaim, total, integration } = ctx;

  const provider = integration.config?.provider;
  if (provider !== 'telr' && provider !== 'ngenius' && provider !== 'ziina') {
    await releaseItemReservation(selectedItems.map((i) => i.id));
    return res.status(400).json({ message: 'This business does not use redirect-based payment' });
  }

  // Record first, so the payment id can ride along in the return URL and
  // the confirm step knows exactly which pending payment to verify.
  const { data: payment, error: paymentError } = await supabaseAdmin
    .from('payments')
    .insert({
      business_id: business.id,
      card_id: tapEvent.card_id,
      order_item_ids: selectedItems.map((i) => i.id),
      amount,
      discount_amount: discountAmount,
      reward_claim_id: appliedClaim?.id || null,
      tip_amount: tipAmount || 0,
      status: 'pending',
      provider,
      source_event_id: tapEventId,
    })
    .select()
    .single();
  if (paymentError) return res.status(400).json({ message: paymentError.message });

  const returnUrl = `${process.env.CLIENT_URL}/${req.params.slug}/pay?paymentId=${payment.id}`;
  const adapter = provider === 'telr'
    ? require('../utils/telrAdapter')
    : provider === 'ngenius'
    ? require('../utils/ngeniusAdapter')
    : require('../utils/ziinaBillAdapter');

  const session = await adapter.createPaymentSession(integration.config, total, 'Tavzio bill payment', payment.id, returnUrl);
  if (!session.success) {
    await supabaseAdmin.from('payments').update({ status: 'failed', failure_reason: session.error || '' }).eq('id', payment.id);
    await releaseItemReservation(selectedItems.map((i) => i.id));
    return res.status(502).json({ message: session.error || 'Could not start the payment' });
  }

  await supabaseAdmin.from('payments').update({ provider_ref: session.providerRef }).eq('id', payment.id);
  res.status(201).json({ paymentId: payment.id, redirectUrl: session.redirectUrl });
});

// @route POST /api/public/business/:slug/bill/cancel
// Body: { paymentId }
// The actual missing piece: a way to give up a payment attempt on
// purpose, rather than making the person - or anyone else waiting on
// the same items - sit out the full 5-minute reservation window for a
// payment nobody intends to finish. Only ever releases the reservation
// this specific payment holds, never anyone else's.
const cancelBillPaySession = asyncHandler(async (req, res) => {
  const { paymentId } = req.body;
  if (!paymentId) return res.status(400).json({ message: 'paymentId is required' });

  const { data: business } = await supabaseAdmin.from('businesses').select('id').eq('slug', req.params.slug).eq('status', 'active').single();
  if (!business) return res.status(404).json({ message: 'Business not found' });

  const { data: payment } = await supabaseAdmin
    .from('payments')
    .select('id, status, order_item_ids')
    .eq('id', paymentId)
    .eq('business_id', business.id)
    .maybeSingle();
  if (!payment) return res.status(404).json({ message: 'Payment not found' });

  // Already resolved one way or the other - nothing to cancel, and
  // never overwrite a real completed/failed outcome with a stale
  // cancel request that arrived late.
  if (payment.status !== 'pending') return res.json({ status: payment.status });

  await supabaseAdmin.from('payments').update({ status: 'failed', failure_reason: 'Cancelled by customer' }).eq('id', payment.id);
  await releaseItemReservation(payment.order_item_ids || []);

  res.json({ status: 'cancelled' });
});

// @route POST /api/public/business/:slug/bill/confirm
// Body: { paymentId, phone? }
// Called when the customer lands back from the provider's page. The
// provider's own status API is the only source of truth here - which
// return URL the customer arrived on proves nothing.
const confirmPaySession = asyncHandler(async (req, res) => {
  const { paymentId, phone } = req.body;
  if (!paymentId) return res.status(400).json({ message: 'paymentId is required' });

  const { data: business } = await supabaseAdmin
    .from('businesses')
    .select('id, features')
    .eq('slug', req.params.slug)
    .eq('status', 'active')
    .single();
  if (!business) return res.status(404).json({ message: 'Business not found' });

  const { data: payment } = await supabaseAdmin
    .from('payments')
    .select('*')
    .eq('id', paymentId)
    .eq('business_id', business.id)
    .maybeSingle();
  if (!payment) return res.status(404).json({ message: 'Payment not found' });

  // Already resolved (double-confirm, refresh of the return page) - just
  // report the final state rather than re-running anything.
  if (payment.status === 'completed') return res.json({ status: 'completed' });
  if (payment.status === 'failed') {
    return res.status(402).json({ message: payment.failure_reason || 'Payment failed', status: 'failed' });
  }

  const { data: integration } = await supabaseAdmin
    .from('pos_integrations')
    .select('*')
    .eq('business_id', business.id)
    .eq('purpose', 'payment')
    .eq('enabled', true)
    .maybeSingle();
  if (!integration) return res.status(404).json({ message: 'Payment is not available for this business' });
  integration.config = decryptConfig(integration.config);

  const adapter = payment.provider === 'telr'
    ? require('../utils/telrAdapter')
    : payment.provider === 'ngenius'
    ? require('../utils/ngeniusAdapter')
    : require('../utils/ziinaBillAdapter');

  const check = await adapter.checkPaymentStatus(integration.config, payment.provider_ref);
  if (!check.success) {
    // Verification itself failed (network, provider outage) - leave the
    // payment 'pending' so a retry of this endpoint can still resolve it.
    return res.status(502).json({ message: check.error || 'Could not verify the payment yet', status: 'pending' });
  }

  if (!check.paid) {
    await supabaseAdmin.from('payments').update({ status: 'failed', failure_reason: check.statusText || 'Not authorised' }).eq('id', payment.id);
    await releaseItemReservation(payment.order_item_ids || []);
    return res.status(402).json({ message: 'Payment was not completed', status: 'failed' });
  }

  const { data: completed } = await supabaseAdmin
    .from('payments')
    .update({ status: 'completed', telr_tran_ref: payment.provider === 'telr' ? (check.tranRef || '') : undefined })
    .eq('id', payment.id)
    .select()
    .single();

  // Rebuild exactly what finalizePaidBill needs from the stored row.
  const { data: items } = await supabaseAdmin
    .from('order_items')
    .select('*')
    .in('id', payment.order_item_ids || []);
  let appliedClaim = null;
  if (payment.reward_claim_id) {
    const { data: claim } = await supabaseAdmin.from('loyalty_reward_claims').select('*').eq('id', payment.reward_claim_id).maybeSingle();
    appliedClaim = claim;
  }
  const amount = Number(payment.amount);
  const discountAmount = Number(payment.discount_amount || 0);
  const discountedAmount = Math.max(0, amount - discountAmount);
  const tipAmount = Number(payment.tip_amount || 0);
  const total = discountedAmount + tipAmount;

  const receipt = await finalizePaidBill({
    business, payment: completed, selectedItems: items || [], appliedClaim,
    discountAmount, discountedAmount, amount, tipAmount, phone, total,
  });

  res.json({ status: 'completed', payment: completed, receipt });
});

// =========================================================================
// Background reconciliation - the actual fix for the gap where a
// customer's phone locks or their connection drops mid-redirect on a
// Telr/N-Genius/Ziina Pay Bill payment. The gateway may have genuinely
// charged them while Tavzio never finds out, because nothing but the
// customer's own browser calling confirmPaySession ever checks. This
// runs on a timer (see server.js) and does exactly what confirmPaySession
// already does - verify server-side against the real gateway, never
// trust anything else - just triggered by a clock instead of a request.
// =========================================================================

// Payments past this age are recovered automatically. Anything genuinely
// still pending isn't rushed - most redirect flows finish in well under
// a minute, so 3 minutes is long enough that a normal in-progress
// checkout is never mistaken for an abandoned one.
const RECONCILE_AFTER_MINUTES = 3;
// Past this age with no resolution, stop retrying and mark it failed -
// an old order should not sit in "pending" forever, silently retried on
// every tick indefinitely. A genuinely late gateway response after this
// point would need a manual look, not automatic recovery.
const GIVE_UP_AFTER_HOURS = 24;

async function reconcilePendingBillPayments() {
  const cutoff = new Date(Date.now() - RECONCILE_AFTER_MINUTES * 60000).toISOString();
  const giveUpCutoff = new Date(Date.now() - GIVE_UP_AFTER_HOURS * 3600000).toISOString();

  const { data: stuckPayments } = await supabaseAdmin
    .from('payments')
    .select('*')
    .eq('status', 'pending')
    .in('provider', ['telr', 'ngenius', 'ziina'])
    .lt('created_at', cutoff);

  for (const payment of stuckPayments || []) {
    if (payment.created_at < giveUpCutoff) {
      await supabaseAdmin.from('payments').update({ status: 'failed', failure_reason: 'Never confirmed - gave up after 24 hours' }).eq('id', payment.id);
      continue;
    }

    try {
      const { data: integration } = await supabaseAdmin
        .from('pos_integrations')
        .select('config')
        .eq('business_id', payment.business_id)
        .eq('purpose', 'payment')
        .eq('enabled', true)
        .maybeSingle();
      if (!integration) continue; // gateway got disconnected since - nothing to check against

      const config = decryptConfig(integration.config);
      const adapter = payment.provider === 'telr'
        ? require('../utils/telrAdapter')
        : payment.provider === 'ngenius'
        ? require('../utils/ngeniusAdapter')
        : require('../utils/ziinaBillAdapter');

      const check = await adapter.checkPaymentStatus(config, payment.provider_ref);
      if (!check.success || !check.paid) continue; // still genuinely pending, or a transient check failure - try again next tick

      const { data: business } = await supabaseAdmin.from('businesses').select('id, features').eq('id', payment.business_id).single();
      const { data: completed } = await supabaseAdmin
        .from('payments')
        .update({ status: 'completed', telr_tran_ref: payment.provider === 'telr' ? (check.tranRef || '') : undefined })
        .eq('id', payment.id)
        .select()
        .single();

      const { data: items } = await supabaseAdmin.from('order_items').select('*').in('id', payment.order_item_ids || []);
      let appliedClaim = null;
      if (payment.reward_claim_id) {
        const { data: claim } = await supabaseAdmin.from('loyalty_reward_claims').select('*').eq('id', payment.reward_claim_id).maybeSingle();
        appliedClaim = claim;
      }
      const amount = Number(payment.amount);
      const discountAmount = Number(payment.discount_amount || 0);
      const discountedAmount = Math.max(0, amount - discountAmount);
      const tipAmount = Number(payment.tip_amount || 0);
      const total = discountedAmount + tipAmount;

      await finalizePaidBill({
        business, payment: completed, selectedItems: items || [], appliedClaim,
        discountAmount, discountedAmount, amount, tipAmount, phone: '', total,
      });
    } catch (err) {
      // One payment's reconciliation blowing up must never stop the rest
      // from being checked on this same tick.
      console.error(`Reconciliation failed for payment ${payment.id}:`, err.message);
    }
  }
}

module.exports = {
  resolveCardTap,
  getPublicBusiness,
  logPublicEvent,
  loyaltyCheckin,
  loyaltyStatus,
  claimReward,
  getPublicMenu,
  submitOrder,
  payOrder,
  createOrderPaySession,
  confirmOrderPayment,
  payOrderWithCash,
  cancelOrderPayment,
  getPublicServices,
  submitBooking,
  markItemsCashPending,
  getBill,
  payBill,
  createPaySession,
  confirmPaySession,
  cancelBillPaySession,
  reconcilePendingBillPayments,
  reconcilePendingOrderPayments,
};

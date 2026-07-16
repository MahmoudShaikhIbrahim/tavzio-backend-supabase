const { supabaseAdmin, supabasePublic } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { notifyCardUsed, sendDeviceConfirmation } = require('../utils/notifications');

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
    .select('id, status, linked_user_id, business_id, businesses(slug, status, name, features)')
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
  const { data: event, error: eventError } = await supabaseAdmin
    .from('events')
    .insert({
      business_id: card.business_id,
      card_id: card.id,
      type: 'nfc_tap',
      ...eventContext(req),
    })
    .select('id')
    .single();

  if (eventError) return res.status(400).json({ message: eventError.message });

  res.json({ redirect: `/${business.slug}`, tapEventId: event.id });
});

// @route GET /api/public/business/:slug
const getPublicBusiness = asyncHandler(async (req, res) => {
  const { data: business, error } = await supabaseAdmin
    .from('businesses')
    .select('id, name, slug, logo_url, cover_image_url, description, links, theme, category, features')
    .eq('slug', req.params.slug)
    .eq('status', 'active')
    .single();

  if (error || !business) return res.status(404).json({ message: 'Business not found' });

  await supabaseAdmin.from('events').insert({ business_id: business.id, type: 'landing_open', ...eventContext(req) });

  // Loyalty is a separate table (richer than a simple link button), so it's
  // fetched alongside and merged into the response for the frontend's
  // convenience. `program` is null if the business hasn't enabled loyalty.
  const [{ data: program }, { data: paymentIntegration }, { data: customButtons }] = await Promise.all([
    supabaseAdmin.from('loyalty_programs').select('type, config').eq('business_id', business.id).eq('enabled', true).maybeSingle(),
    supabaseAdmin.from('pos_integrations').select('enabled').eq('business_id', business.id).eq('purpose', 'payment').eq('enabled', true).maybeSingle(),
    supabaseAdmin.from('custom_buttons').select('*').eq('business_id', business.id).eq('enabled', true).order('sort_order'),
  ]);

  res.json({
    ...business,
    loyaltyProgram: program || null,
    paymentEnabled: !!paymentIntegration,
    customButtons: customButtons || [],
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
// UAE standard VAT rate - menu prices are treated as VAT-inclusive
// (standard local practice), so this is used to derive the breakdown
// shown on receipts and exports, not added on top of displayed prices.
const UAE_VAT_RATE = 0.05;

// Applies one program's rule to a membership row and returns the updated
// fields to persist, plus the transaction amount/type to log.
function applyEarn(program, membership) {
  const cfg = program.config || {};

  if (program.type === 'punch_card') {
    const visits = membership.visits + 1;
    const required = cfg.visitsRequired || 10;
    return {
      update: { visits },
      tx: { type: 'earn_visit', amount: 1 },
      rewardReady: visits > 0 && visits % required === 0,
    };
  }

  if (program.type === 'points') {
    const perVisit = cfg.pointsPerVisit || 10;
    const points = membership.points + perVisit;
    const threshold = cfg.redeemThreshold || 100;
    return {
      update: { points },
      tx: { type: 'earn_points', amount: perVisit },
      rewardReady: points >= threshold,
    };
  }

  if (program.type === 'tiered') {
    const visits = membership.visits + 1;
    const tiers = [...(cfg.tiers || [])].sort((a, b) => b.visitsRequired - a.visitsRequired);
    const earnedTier = tiers.find((t) => visits >= t.visitsRequired) || null;
    return {
      update: { visits, current_tier: earnedTier ? earnedTier.name : membership.current_tier },
      tx: { type: 'earn_visit', amount: 1 },
      rewardReady: false, // tiers are ongoing perks, not one-time redemptions
    };
  }

  // 'spend' type isn't earned via self check-in — a tap alone doesn't know
  // the bill amount. It still logs the visit for the record, but spend
  // amounts are added later by staff via the dashboard adjust endpoint.
  return {
    update: { visits: membership.visits + 1 },
    tx: { type: 'earn_visit', amount: 0 },
    rewardReady: false,
  };
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

  res.json({ membership: updatedMembership, rewardReady, alreadyCounted: false });
});

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

  res.json({ membership: membership || null });
});

// @route GET /api/public/business/:slug/menu
// Only returns data if ordering.menuView is enabled - matches the RLS rule.
const getPublicMenu = asyncHandler(async (req, res) => {
  const { data: business } = await supabaseAdmin
    .from('businesses')
    .select('id, features')
    .eq('slug', req.params.slug)
    .eq('status', 'active')
    .single();
  if (!business) return res.status(404).json({ message: 'Business not found' });
  if (!business.features?.ordering?.menuView) {
    return res.status(404).json({ message: 'Ordering is not available for this business' });
  }

  const [{ data: categories }, { data: items }] = await Promise.all([
    supabaseAdmin.from('menu_categories').select('*').eq('business_id', business.id).order('sort_order'),
    supabaseAdmin.from('menu_items').select('*').eq('business_id', business.id).eq('is_available', true).order('sort_order'),
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
  const itemsWithAddons = (items || []).map((i) => ({ ...i, addons: addonsByItem[i.id] || [] }));

  // Tells the frontend whether this is a read-only menu (menuView on,
  // submission off - browse only, no cart) or the full cart flow.
  res.json({
    categories: categories || [],
    items: itemsWithAddons,
    submissionEnabled: !!business.features?.ordering?.submission,
    callWaiterEnabled: !!business.features?.ordering?.callWaiter,
    requestBillEnabled: !!business.features?.ordering?.requestBill,
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
    .select('id, features')
    .eq('slug', req.params.slug)
    .eq('status', 'active')
    .single();
  if (!business) return res.status(404).json({ message: 'Business not found' });

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
      .select('id, name, price')
      .in('id', menuItemIds)
      .eq('business_id', business.id)
      .eq('is_available', true);

    if (!menuItems || menuItems.length !== menuItemIds.length) {
      return res.status(400).json({ message: 'One or more items are no longer available' });
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
    integration = data;
  }

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
    integration = data;
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

  const items = (orders || [])
    .flatMap((o) => o.order_items.map((i) => ({ ...i, order_id: o.id })))
    .filter((i) => !i.paid && !i.voided);

  const total = items.reduce((sum, i) => sum + (i.unit_price + Number(i.addon_total || 0)) * i.quantity, 0);
  res.json({ items, total });
});

// @route POST /api/public/business/:slug/bill/pay
// Body: { tapEventId, itemIds?, tipAmount, tapToken, phone? }
// `itemIds` omitted/null means "pay everything currently unpaid" - either
// way, any customer can select any combination, including items someone
// else ordered (people cover each other's food often) - never auto-split
// by who tapped or who ordered.
const payBill = asyncHandler(async (req, res) => {
  const { tapEventId, itemIds, tipAmount = 0, tapToken, phone } = req.body;
  if (!tapEventId || !tapToken) {
    return res.status(400).json({ message: 'tapEventId and tapToken are required' });
  }

  const { data: business } = await supabaseAdmin
    .from('businesses')
    .select('id, features')
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
    return res.status(400).json({ message: 'Payment must follow a real tap, and this one has expired or is invalid' });
  }

  const { data: orders } = await supabaseAdmin
    .from('orders')
    .select('id, order_items(*)')
    .eq('business_id', business.id)
    .eq('card_id', tapEvent.card_id)
    .eq('request_type', 'order')
    .eq('voided', false)
    .neq('status', 'cancelled');

  const unpaidItems = (orders || []).flatMap((o) => o.order_items).filter((i) => !i.paid && !i.voided);
  const selectedItems = Array.isArray(itemIds) && itemIds.length > 0
    ? unpaidItems.filter((i) => itemIds.includes(i.id))
    : unpaidItems;

  if (selectedItems.length === 0) {
    return res.status(400).json({ message: 'Nothing to pay' });
  }

  const amount = selectedItems.reduce((sum, i) => sum + (i.unit_price + Number(i.addon_total || 0)) * i.quantity, 0);
  const total = amount + Number(tipAmount || 0);

  const { data: integration } = await supabaseAdmin
    .from('pos_integrations')
    .select('*')
    .eq('business_id', business.id)
    .eq('purpose', 'payment')
    .eq('enabled', true)
    .maybeSingle();
  if (!integration) {
    return res.status(404).json({ message: 'Payment is not available for this business yet' });
  }

  const { createCharge } = require('../utils/tapPaymentsAdapter');
  const result = await createCharge(integration.config, tapToken, total, 'Tavzio bill payment');

  const { data: payment, error: paymentError } = await supabaseAdmin
    .from('payments')
    .insert({
      business_id: business.id,
      card_id: tapEvent.card_id,
      order_item_ids: selectedItems.map((i) => i.id),
      amount,
      tip_amount: tipAmount || 0,
      status: result.success ? 'completed' : 'failed',
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

  await supabaseAdmin
    .from('order_items')
    .update({ paid: true })
    .in('id', selectedItems.map((i) => i.id));

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
      .eq('type', 'spend')
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
  // practice), so VAT is derived from the total rather than added on top.
  // English only, per explicit decision - not run through translation.
  const vatAmount = Math.round((amount - amount / (1 + UAE_VAT_RATE)) * 100) / 100;
  const subtotalExVat = Math.round((amount - vatAmount) * 100) / 100;

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
    vatRate: UAE_VAT_RATE,
    tip: Number(tipAmount || 0),
    total,
    paidAt: payment.created_at,
    paymentId: payment.id,
  };

  res.status(201).json({ payment, receipt });
});

module.exports = {
  resolveCardTap,
  getPublicBusiness,
  logPublicEvent,
  loyaltyCheckin,
  loyaltyStatus,
  getPublicMenu,
  submitOrder,
  getPublicServices,
  submitBooking,
  getBill,
  payBill,
};

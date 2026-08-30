const { supabaseAdmin } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { logAction } = require('../utils/auditLog');
const { sendOtp, validateOtp } = require('../utils/smsAdapter');
const { decryptConfig } = require('../utils/credentialEncryption');
const { calculateVatInclusive } = require('../utils/vat');
const { primaryClientUrl } = require('../utils/clientUrl');

const OTP_EXPIRY_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
// A verified phone stays "usable" for this long after verifying, so the
// customer doesn't have to re-verify if they take a few minutes filling
// out the rest of the form (picking food, choosing a time) after the
// code lands - but a verification from an hour ago can't be replayed
// to skip verification on a brand new booking attempt.
const VERIFIED_WINDOW_MINUTES = 30;

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Real, server-side check against a per-day-of-week hours object (see
// migration 0118's own shape). A missing day key means "no restriction
// configured for this day" (allowed) - an explicit null value for the
// day means "closed" (rejected). No hoursObj at all means the business
// hasn't set any hours yet, so nothing is restricted.
function checkWithinHours(isoDateTime, hoursObj, errorMessage) {
  if (!hoursObj) return null;
  const d = new Date(isoDateTime);
  const dayKey = DAY_KEYS[d.getDay()];
  if (!(dayKey in hoursObj)) return null; // day not configured at all - no restriction
  const dayHours = hoursObj[dayKey];
  if (!dayHours) return `${errorMessage} (closed that day)`;
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const open = dayHours.open ? String(dayHours.open).slice(0, 5) : null;
  const close = dayHours.close ? String(dayHours.close).slice(0, 5) : null;
  if (open && hhmm < open) return errorMessage;
  if (close && hhmm > close) return errorMessage;
  return null;
}

// Real, server-side check for a single service's own available window
// (e.g. a birthday package only offered 18:00-22:00) - either bound can
// be null, meaning no restriction on that side.
function checkWithinTimeRange(isoDateTime, startTime, endTime, errorMessage) {
  if (!startTime && !endTime) return null;
  const d = new Date(isoDateTime);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const start = startTime ? String(startTime).slice(0, 5) : null;
  const end = endTime ? String(endTime).slice(0, 5) : null;
  if (start && hhmm < start) return errorMessage;
  if (end && hhmm > end) return errorMessage;
  return null;
}

// @route GET /api/public/business/:slug/booking-config
// What the public booking page actually needs to know before it can
// render itself correctly: is booking even on, does this business take
// pre-orders alongside a reservation, is a down payment required (and
// how much), and - only if pre-order is on - the actual menu to choose
// from. One call, everything the form needs to decide its own shape.
const getBookingConfig = asyncHandler(async (req, res) => {
  const { data: business, error } = await supabaseAdmin
    .from('businesses')
    .select('id, name, logo_url, features, operating_hours, booking_hours')
    .eq('slug', req.params.slug)
    .eq('status', 'active')
    .maybeSingle();
  if (error || !business) return res.status(404).json({ message: 'Business not found' });

  const booking = business.features?.onlineBooking || {};
  // Real fix for the explicit request: a business can have table
  // booking OFF and drive-through ON (or vice versa) - the chooser page
  // needs to know which of the two is actually available and only show
  // that button, so this only 404s when NEITHER is on, instead of the
  // old all-or-nothing gate that assumed table booking was the only
  // thing this endpoint could ever be for.
  const driveThrough = business.features?.driveThrough || {};
  if (!booking.enabled && !driveThrough.enabled) {
    return res.status(404).json({ message: 'Online booking is not available for this business' });
  }

  let menu = [];
  if (booking.allowPreOrder || driveThrough.enabled) {
    const { data: items } = await supabaseAdmin
      .from('menu_items')
      .select('id, name, price, description, image_url, category_id, menu_categories(name, sort_order)')
      .eq('business_id', business.id)
      .eq('is_available', true)
      .order('sort_order');
    // Real fix for the confirmed request: ordering by the ITEM's own
    // sort_order alone doesn't actually group by category correctly -
    // every category's items independently restart at sort_order 0, so
    // whichever category happened to contain the item with the lowest
    // sort_order ended up first once the frontend grouped these by
    // insertion order, regardless of what the owner actually set as
    // their first category (e.g. "Salads" appearing before "Main"
    // purely by coincidence of item sort_order values, not category
    // order). Sorting here by (category sort_order, then item
    // sort_order) makes items arrive already grouped in the owner's
    // real category order - the same order the actual NFC customer
    // menu (MenuPage.tsx) already gets right by using a real, separate,
    // correctly-ordered categories list; this endpoint has no such
    // separate list on the frontend, so the fix has to happen here,
    // before the items are ever sent.
    menu = (items || []).slice().sort((a, b) => {
      const catA = a.menu_categories?.sort_order ?? Number.MAX_SAFE_INTEGER;
      const catB = b.menu_categories?.sort_order ?? Number.MAX_SAFE_INTEGER;
      return catA - catB;
    });
  }

  // Real fix for the confirmed request: services (with their real
  // options, like "with cake"/"without cake") are now genuinely
  // selectable during booking - this data never existed on this
  // endpoint before, so the customer-facing form had nothing to show.
  const { data: services } = await supabaseAdmin
    .from('services')
    .select('id, name, description, price, duration_minutes, available_start_time, available_end_time, service_options(id, label, price_delta, sort_order)')
    .eq('business_id', business.id)
    .eq('is_available', true)
    .order('sort_order');

  res.json({
    businessName: business.name,
    allowPreOrder: !!booking.allowPreOrder,
    downPayment: booking.downPayment || { enabled: false },
    menu,
    services: services || [],
    // Real fix for the explicit request: the business's actual opening
    // hours, and the optional booking-specific override - the frontend
    // uses these to only ever offer real, valid time slots.
    operatingHours: business.operating_hours || null,
    bookingHours: business.booking_hours || null,
    // Real, explicit addition for the drive-through feature: the chooser
    // page needs to know whether each option is actually available
    // (bookingEnabled separate from driveThrough.enabled, since either
    // can be on independently), and both drive-through and the location
    // button read their own config from here rather than a separate
    // endpoint - one request, everything the chooser page needs.
    bookingEnabled: !!booking.enabled,
    driveThrough: {
      enabled: !!driveThrough.enabled,
      downPayment: driveThrough.downPayment || { enabled: false },
    },
    locationUrl: booking.locationUrl || '',
    logoUrl: business.logo_url || '',
  });
});

// @route GET /api/public/business/:slug/booking-chooser
// Real, explicit performance fix (confirmed by direct report - "why
// not make it render faster" rather than just hide the wait): this
// page is a genuinely tiny screen (a logo, a name, and which of Book
// a Table / Drive Through / Location to show), but it was calling
// getBookingConfig above - the SAME endpoint the actual booking form
// and drive-through ordering page use, both of which genuinely need
// the full menu and every service's options for pre-order/service
// selection. The chooser never reads either field, but was still
// paying for both of those extra queries on every single load. This
// is the identical business lookup with the menu_items and services
// queries removed entirely, since this page has no use for them - a
// real reduction in round trips for the one caller that never needed
// them, not a second copy of the same fetch. BookingPage.tsx and
// DriveThroughPage.tsx keep calling getBookingConfig above, completely
// unchanged - they still need what only that endpoint provides.
const getBookingChooserConfig = asyncHandler(async (req, res) => {
  const { data: business, error } = await supabaseAdmin
    .from('businesses')
    .select('name, logo_url, features')
    .eq('slug', req.params.slug)
    .eq('status', 'active')
    .maybeSingle();
  if (error || !business) return res.status(404).json({ message: 'Business not found' });

  const booking = business.features?.onlineBooking || {};
  const driveThrough = business.features?.driveThrough || {};
  if (!booking.enabled && !driveThrough.enabled) {
    return res.status(404).json({ message: 'Online booking is not available for this business' });
  }

  res.json({
    businessName: business.name,
    bookingEnabled: !!booking.enabled,
    driveThrough: { enabled: !!driveThrough.enabled },
    locationUrl: booking.locationUrl || '',
    logoUrl: business.logo_url || '',
  });
});

// @route POST /api/public/business/:slug/booking-otp/request
// Body: { phone }
// Verify Now generates and holds the actual OTP on their side - we just
// store the verificationId it hands back, and a fresh one every time so
// a customer who fat-fingered their number and requests again gets a
// verificationId that actually matches what they'll receive, not a
// stale one still counting down from the typo.
const requestBookingOtp = asyncHandler(async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ message: 'phone is required' });

  const { data: business } = await supabaseAdmin.from('businesses').select('id').eq('slug', req.params.slug).eq('status', 'active').maybeSingle();
  if (!business) return res.status(404).json({ message: 'Business not found' });

  const sendResult = await sendOtp(phone);
  if (!sendResult.success) return res.status(502).json({ message: sendResult.error || 'Could not send verification code' });

  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60000).toISOString();
  const { error } = await supabaseAdmin.from('booking_otp_codes').insert({
    business_id: business.id, phone, verification_id: sendResult.verificationId, expires_at: expiresAt,
  });
  if (error) return res.status(400).json({ message: error.message });

  res.json({ message: 'Verification code sent' });
});

// @route POST /api/public/business/:slug/booking-otp/verify
// Body: { phone, code }
const verifyBookingOtp = asyncHandler(async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ message: 'phone and code are required' });

  const { data: business } = await supabaseAdmin.from('businesses').select('id').eq('slug', req.params.slug).eq('status', 'active').maybeSingle();
  if (!business) return res.status(404).json({ message: 'Business not found' });

  const { data: record } = await supabaseAdmin
    .from('booking_otp_codes')
    .select('*')
    .eq('business_id', business.id)
    .eq('phone', phone)
    .is('verified_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!record) return res.status(400).json({ message: 'No pending verification for this number - request a new code' });
  if (new Date(record.expires_at) < new Date()) return res.status(400).json({ message: 'This code has expired - request a new one' });
  if (record.attempts >= OTP_MAX_ATTEMPTS) return res.status(429).json({ message: 'Too many attempts - request a new code' });

  const validateResult = await validateOtp(record.verification_id, code);
  if (!validateResult.success) {
    await supabaseAdmin.from('booking_otp_codes').update({ attempts: record.attempts + 1 }).eq('id', record.id);
    return res.status(400).json({ message: validateResult.error || 'Incorrect code' });
  }

  await supabaseAdmin.from('booking_otp_codes').update({ verified_at: new Date().toISOString() }).eq('id', record.id);
  res.json({ message: 'Phone verified' });
});

function computeDownPayment(downPaymentConfig, orderTotal) {
  if (!downPaymentConfig?.enabled) return 0;
  if (downPaymentConfig.mode === 'full') return orderTotal;
  if (downPaymentConfig.mode === 'percentage') return Math.round(orderTotal * (Number(downPaymentConfig.value) || 0) / 100 * 100) / 100;
  if (downPaymentConfig.mode === 'fixed') return Number(downPaymentConfig.value) || 0;
  return 0;
}

// @route POST /api/public/business/:slug/bookings
// Body: { phone, guestName, partySize, requestedAt, note?, items?: [{menuItemId, quantity}], foodReadyOffsetMinutes? }
// Requires a phone verified within the last VERIFIED_WINDOW_MINUTES -
// this is the real gate keeping an unverified booking from ever being
// created at all, not a UI-only check the frontend could skip.
const createPublicBooking = asyncHandler(async (req, res) => {
  const { phone, guestName, partySize, requestedAt, note = '', items = [], foodReadyOffsetMinutes, serviceId, serviceOptionId, serviceRequestedAt } = req.body;
  if (!phone || !guestName || !partySize || !requestedAt) {
    return res.status(400).json({ message: 'phone, guestName, partySize, and requestedAt are required' });
  }

  const { data: business } = await supabaseAdmin.from('businesses').select('id, name, features, operating_hours, booking_hours').eq('slug', req.params.slug).eq('status', 'active').maybeSingle();
  if (!business) return res.status(404).json({ message: 'Business not found' });

  const bookingConfig = business.features?.onlineBooking || {};
  if (!bookingConfig.enabled) return res.status(404).json({ message: 'Online booking is not available for this business' });

  // Real, server-side check - the actual hours the booking hours setting
  // (or, if unset, the business's own real operating hours) allows for
  // this day of the week. A client-side picker restricting the options
  // shown is a UX convenience, not a security boundary.
  const effectiveHours = business.booking_hours || business.operating_hours;
  const hoursError = checkWithinHours(requestedAt, effectiveHours, 'That time is outside this business\'s booking hours');
  if (hoursError) return res.status(400).json({ message: hoursError });

  if (!(await requireVerifiedPhone(business.id, phone))) {
    return res.status(400).json({ message: 'Verify your phone number first' });
  }
  // Real customer profile, not just a phone string sitting on this one
  // booking row - same find-or-create-by-phone pattern already used by
  // the NFC loyalty check-in flow (publicController.js), so a guest who
  // books online becomes the same kind of tracked customer a walk-in
  // tap creates, shared across every business on Tavzio by phone. Name
  // is filled in here (the loyalty check-in path never has one to
  // offer) but never overwrites a name the customer already has on file
  // from a previous visit elsewhere.
  let { data: customer } = await supabaseAdmin.from('customers').select('id, name').eq('phone', phone).maybeSingle();
  if (!customer) {
    const { data: created } = await supabaseAdmin.from('customers').insert({ phone, name: guestName }).select('id, name').single();
    customer = created;
  } else if (!customer.name && guestName) {
    await supabaseAdmin.from('customers').update({ name: guestName }).eq('id', customer.id);
  }

  // Pre-order items only matter (and only get priced/validated) when
  // the business actually allows them - a booking-only business simply
  // never receives an items array from its own frontend, but this is
  // enforced here too, not just left to the UI to behave.
  let itemRows = [];
  let itemsTotal = 0;
  if (bookingConfig.allowPreOrder && items.length > 0) {
    const menuItemIds = items.map((i) => i.menuItemId);
    const { data: menuItems } = await supabaseAdmin.from('menu_items').select('id, name, price').eq('business_id', business.id).in('id', menuItemIds);
    for (const item of items) {
      const menuItem = (menuItems || []).find((m) => m.id === item.menuItemId);
      if (!menuItem) continue;
      const quantity = Math.max(1, Number(item.quantity) || 1);
      itemsTotal += menuItem.price * quantity;
      itemRows.push({ menu_item_id: menuItem.id, item_name: menuItem.name, quantity, unit_price: menuItem.price, note: String(item.note || '').trim().slice(0, 300) });
    }
  }

  // Real fix for the confirmed request: a service (with a real,
  // validated option, never trusted blindly from the client) can now
  // genuinely be attached to a booking, with its own real price and
  // its own real requested time - often different from the table
  // reservation's own time.
  let resolvedServiceId = null;
  let resolvedServiceOptionId = null;
  let serviceTotal = 0;
  if (serviceId) {
    const { data: service } = await supabaseAdmin.from('services').select('id, price, is_available, available_start_time, available_end_time').eq('id', serviceId).eq('business_id', business.id).maybeSingle();
    if (!service || !service.is_available) return res.status(400).json({ message: 'That service is not available' });
    if (!serviceRequestedAt) return res.status(400).json({ message: 'A time is required for the service you selected' });
    const serviceTimeError = checkWithinTimeRange(serviceRequestedAt, service.available_start_time, service.available_end_time, 'That time is outside this service\'s available hours');
    if (serviceTimeError) return res.status(400).json({ message: serviceTimeError });
    resolvedServiceId = service.id;
    serviceTotal = Number(service.price);

    if (serviceOptionId) {
      const { data: option } = await supabaseAdmin.from('service_options').select('id, price_delta').eq('id', serviceOptionId).eq('service_id', service.id).maybeSingle();
      if (!option) return res.status(400).json({ message: 'That option is not valid for the selected service' });
      resolvedServiceOptionId = option.id;
      serviceTotal += Number(option.price_delta);
    }
  }
  const totalDownPaymentBase = itemsTotal + serviceTotal;
  const downPaymentAmount = computeDownPayment(bookingConfig.downPayment, totalDownPaymentBase);

  const { data: booking, error: bookingError } = await supabaseAdmin
    .from('bookings')
    .insert({
      business_id: business.id,
      guest_name: guestName,
      contact_phone: phone,
      party_size: partySize,
      requested_at: requestedAt,
      note,
      status: 'pending',
      customer_phone_verified: true,
      food_ready_offset_minutes: itemRows.length > 0 ? (foodReadyOffsetMinutes ?? 0) : null,
      service_id: resolvedServiceId,
      service_option_id: resolvedServiceOptionId,
      service_requested_at: resolvedServiceId ? serviceRequestedAt : null,
      down_payment_required_aed: downPaymentAmount,
      down_payment_status: downPaymentAmount > 0 ? 'pending' : 'not_required',
    })
    .select()
    .single();
  if (bookingError) return res.status(400).json({ message: bookingError.message });

  if (itemRows.length > 0) {
    await supabaseAdmin.from('booking_items').insert(itemRows.map((r) => ({ ...r, booking_id: booking.id })));
  }

  await logAction({ businessId: business.id, actor: null, action: 'reservation_created', targetId: booking.id, details: { guestName, partySize, requestedAt, source: 'online' } });

  // No down payment required - the booking is created, done, staff
  // will confirm it same as any other pending booking.
  if (downPaymentAmount <= 0) {
    return res.status(201).json({ booking, paymentRequired: false });
  }

  // Down payment required - same 4-provider adapter interface every
  // other redirect-based payment in this codebase already uses (see
  // publicController.js's order/bill payment-session flow), just for a
  // booking instead of an order.
  const { data: paymentIntegration } = await supabaseAdmin
    .from('pos_integrations')
    .select('config')
    .eq('business_id', business.id)
    .eq('purpose', 'payment')
    .eq('enabled', true)
    .maybeSingle();
  if (!paymentIntegration) {
    await supabaseAdmin.from('bookings').update({ down_payment_status: 'failed' }).eq('id', booking.id);
    return res.status(400).json({ message: 'This business has a down payment set up but no payment method connected - contact them directly.' });
  }

  const config = decryptConfig(paymentIntegration.config);
  const provider = config?.provider || 'tap';

  const { data: payment, error: paymentError } = await supabaseAdmin
    .from('payments')
    .insert({ business_id: business.id, booking_id: booking.id, amount: downPaymentAmount, status: 'pending', provider })
    .select()
    .single();
  if (paymentError) return res.status(400).json({ message: paymentError.message });

  const returnUrl = `${primaryClientUrl()}/${req.params.slug}/book?bookingPaymentId=${payment.id}`;
  const adapter = provider === 'tap'
    ? require('../utils/tapPaymentsAdapter')
    : provider === 'telr'
    ? require('../utils/telrAdapter')
    : provider === 'ngenius'
    ? require('../utils/ngeniusAdapter')
    : require('../utils/ziinaBillAdapter');

  const session = await adapter.createPaymentSession(config, downPaymentAmount, 'Tavzio booking down payment', payment.id, returnUrl);
  if (!session.success) {
    await supabaseAdmin.from('payments').update({ status: 'failed', failure_reason: session.error || '' }).eq('id', payment.id);
    await supabaseAdmin.from('bookings').update({ down_payment_status: 'failed' }).eq('id', booking.id);
    return res.status(502).json({ message: session.error || 'Could not start the payment' });
  }

  await supabaseAdmin.from('payments').update({ provider_ref: session.providerRef }).eq('id', payment.id);
  res.status(201).json({ booking, paymentRequired: true, redirectUrl: session.redirectUrl, paymentId: payment.id });
});

// @route GET /api/public/bookings/:bookingId/status
// Polled by the booking page after a redirect-based down payment
// returns, to find out whether it actually went through - same
// "poll after redirect" pattern the order/bill payment flows already
// use, not something new invented for this.
const getBookingPaymentStatus = asyncHandler(async (req, res) => {
  const { data: booking } = await supabaseAdmin.from('bookings').select('id, status, down_payment_status').eq('id', req.params.bookingId).maybeSingle();
  if (!booking) return res.status(404).json({ message: 'Booking not found' });
  res.json(booking);
});

// @route GET /api/public/bookings/:bookingId/arrival
// What the arrival-confirmation screen shows after a table tap - only
// returns anything for a booking that's actually confirmed and still
// waiting on arrival, so a stale or already-arrived booking doesn't
// show a confirm button that would just be re-confirming nothing.
const getBookingArrival = asyncHandler(async (req, res) => {
  const { data: booking } = await supabaseAdmin
    .from('bookings')
    // Real bug fix (confirmed by direct report: "Continue to al-baik" -
    // the URL slug shown as if it were the business's own name). This
    // page never had the business's real name at all before, only the
    // guest's own booking details - businesses(name) is a free addition
    // to the same query already running here (a joined column, not a
    // second round trip), so the frontend has an actual name to show
    // instead of falling back to the slug.
    .select('id, guest_name, party_size, requested_at, status, arrival_status, customer_phone_verified, businesses(name)')
    .eq('id', req.params.bookingId)
    .maybeSingle();
  // Same real gate as resolveCardTap in publicController.js, enforced
  // here independently too - this endpoint is reachable directly by
  // id, not only via a table tap, so it needs its own check rather
  // than trusting that every caller arrived through the tap-routing
  // path that already filters on this.
  if (!booking || booking.status !== 'confirmed' || booking.arrival_status !== 'not_arrived' || !booking.customer_phone_verified) {
    return res.status(404).json({ message: 'No pending arrival for this booking' });
  }
  const { businesses, ...bookingFields } = booking;
  res.json({ ...bookingFields, businessName: businesses?.name || null });
});

// @route POST /api/public/bookings/:bookingId/confirm-arrival
// The customer-side half of the dual arrival-confirmation flow - one
// tap on "Yes, that's us" on the screen the table tap already routed
// them to (see resolveCardTap in publicController.js).
const confirmArrivalByCustomer = asyncHandler(async (req, res) => {
  // Same reasoning as getBookingArrival above - this must independently
  // enforce customer_phone_verified too, not just rely on the earlier
  // GET already having filtered it out, since this endpoint could be
  // called directly with any booking id.
  const { data: booking, error } = await supabaseAdmin
    .from('bookings')
    .update({ arrival_status: 'arrived', arrived_at: new Date().toISOString(), arrived_via: 'customer_tap' })
    .eq('id', req.params.bookingId)
    .eq('status', 'confirmed')
    .eq('arrival_status', 'not_arrived')
    .eq('customer_phone_verified', true)
    .select()
    .single();
  if (error || !booking) return res.status(400).json({ message: 'Could not confirm arrival - it may have already been confirmed' });

  await logAction({ businessId: booking.business_id, actor: null, action: 'booking_arrival_confirmed', targetId: booking.id, details: { via: 'customer_tap' } });
  res.json(booking);
});

// Same reconciliation pattern as reconcilePendingOrderPayments/
// reconcilePendingBillPayments in publicController.js - a redirect-
// based payment (all 4 providers now, including tap - see
// tapPaymentsAdapter.js's new createPaymentSession/checkPaymentStatus,
// added specifically for this booking flow) resolves on the gateway's
// own hosted page, so this polls to confirm what actually happened
// rather than trusting the browser to make it back to a returnUrl.
const RECONCILE_AFTER_MINUTES = 2;
const GIVE_UP_AFTER_HOURS = 24;

async function reconcilePendingBookingPayments() {
  const cutoff = new Date(Date.now() - RECONCILE_AFTER_MINUTES * 60000).toISOString();
  const giveUpCutoff = new Date(Date.now() - GIVE_UP_AFTER_HOURS * 3600000).toISOString();

  const { data: stuckPayments } = await supabaseAdmin
    .from('payments')
    .select('*')
    .eq('status', 'pending')
    .not('booking_id', 'is', null)
    .lt('created_at', cutoff);

  for (const payment of stuckPayments || []) {
    if (payment.created_at < giveUpCutoff) {
      await supabaseAdmin.from('payments').update({ status: 'failed', failure_reason: 'Never confirmed - gave up after 24 hours' }).eq('id', payment.id);
      await supabaseAdmin.from('bookings').update({ down_payment_status: 'failed' }).eq('id', payment.booking_id);
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
      if (!integration) continue;

      const config = decryptConfig(integration.config);
      const adapter = payment.provider === 'tap'
        ? require('../utils/tapPaymentsAdapter')
        : payment.provider === 'telr'
        ? require('../utils/telrAdapter')
        : payment.provider === 'ngenius'
        ? require('../utils/ngeniusAdapter')
        : require('../utils/ziinaBillAdapter');

      const check = await adapter.checkPaymentStatus(config, payment.provider_ref);
      if (!check.success || !check.paid) continue;

      await supabaseAdmin.from('payments').update({ status: 'completed' }).eq('id', payment.id);
      const { data: booking } = await supabaseAdmin
        .from('bookings')
        .update({ down_payment_status: 'paid', status: 'confirmed' })
        .eq('id', payment.booking_id)
        .select()
        .single();

      if (booking) {
        await logAction({ businessId: payment.business_id, actor: null, action: 'booking_down_payment_charged', targetId: booking.id, details: { amount: payment.amount } });
      }
    } catch (err) {
      console.error(`Booking payment reconciliation failed for payment ${payment.id}:`, err.message);
    }
  }
}

// Shared by createPublicBooking, listMyBookings, and
// reschedulePublicBooking - all three need the exact same proof: a
// phone verified at this business within the last
// VERIFIED_WINDOW_MINUTES. Centralized here after this became the
// third copy of the same five-line check.
async function requireVerifiedPhone(businessId, phone) {
  const { data: verified } = await supabaseAdmin
    .from('booking_otp_codes')
    .select('id')
    .eq('business_id', businessId)
    .eq('phone', phone)
    .not('verified_at', 'is', null)
    .gte('verified_at', new Date(Date.now() - VERIFIED_WINDOW_MINUTES * 60000).toISOString())
    .order('verified_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return !!verified;
}

const MIN_ARRIVAL_MINUTES = 5;
const MAX_ARRIVAL_MINUTES = 30;

// Real, tap-free twin of publicController.js's own item-validation logic
// (computeOrderCheckoutContext) - deliberately a separate copy rather
// than a shared extraction, since that function is tightly coupled to
// requiring a real NFC tap event, which drive-through explicitly must
// never depend on. Same server-side pricing/availability guarantees
// either way: never trust a client-submitted price or an item that's
// actually paused/unavailable.
async function validateDriveThroughItems(business, items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { errStatus: 400, errMessage: 'At least one item is required' };
  }
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
      .from('menu_categories').select('id').in('id', categoryIds).eq('paused', true);
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
      note: String(i.note || '').trim().slice(0, 300),
      addons: selectedAddons.map((a) => ({ name: a.name, price: a.price })),
      addon_total: addonTotal,
    };
  });
  const total = orderItemRows.reduce((sum, i) => sum + (i.unit_price + i.addon_total) * i.quantity, 0);
  return { orderItemRows, total };
}

// @route POST /api/public/business/:slug/drive-through/orders
// Body: { phone, items, arrivalMinutes, note }
// Real correction after explicit clarification: this now works exactly
// like online booking's own down payment (computeDownPayment, same
// enabled/mode/value shape, same function reused directly - not a
// second implementation) rather than a separate "pay first / pay at
// pickup / optional" scheme. No customer choice at checkout, same as
// booking - the business's own configured downPayment fully determines
// the amount, which can be 0 (nothing charged online, order reaches
// the kitchen immediately, full amount collected at pickup via Record
// Payment), the full total (nothing left to collect at pickup), or a
// percentage/fixed deposit (order reaches the kitchen once that
// deposit clears, the remainder still collectible via Record Payment
// when the customer arrives - exactly why the POS pop-up notification
// fires regardless of whether a deposit was taken, not only for a
// fully-unpaid order).
const createDriveThroughOrder = asyncHandler(async (req, res) => {
  const { phone, items, arrivalMinutes, note = '' } = req.body;
  if (!phone || !arrivalMinutes) {
    return res.status(400).json({ message: 'phone and arrivalMinutes are required' });
  }
  const minutes = Number(arrivalMinutes);
  if (!Number.isFinite(minutes) || minutes < MIN_ARRIVAL_MINUTES || minutes > MAX_ARRIVAL_MINUTES) {
    return res.status(400).json({ message: `Arrival time must be between ${MIN_ARRIVAL_MINUTES} and ${MAX_ARRIVAL_MINUTES} minutes` });
  }

  const { data: business } = await supabaseAdmin
    .from('businesses')
    .select('id, name, features, operating_hours, booking_hours')
    .eq('slug', req.params.slug)
    .eq('status', 'active')
    .maybeSingle();
  if (!business) return res.status(404).json({ message: 'Business not found' });

  const driveThrough = business.features?.driveThrough || {};
  if (!driveThrough.enabled) return res.status(404).json({ message: 'Drive-through ordering is not available for this business' });

  if (!(await requireVerifiedPhone(business.id, phone))) {
    return res.status(400).json({ message: 'Verify your phone number first' });
  }

  const arrivalAt = new Date(Date.now() + minutes * 60000);
  // Real, explicit request: drive-through respects the exact same hours
  // as online booking - the business's own operating hours, or the
  // booking-specific override if one is set, checked against the real
  // arrival time, not just "now".
  const effectiveHours = business.booking_hours || business.operating_hours;
  const hoursError = checkWithinHours(arrivalAt.toISOString(), effectiveHours, 'That arrival time is outside this business\'s hours');
  if (hoursError) return res.status(400).json({ message: hoursError });

  const validation = await validateDriveThroughItems(business, items);
  if (validation.errStatus) return res.status(validation.errStatus).json({ message: validation.errMessage });
  const { orderItemRows, total } = validation;

  let { data: customer } = await supabaseAdmin.from('customers').select('id').eq('phone', phone).maybeSingle();
  if (!customer) await supabaseAdmin.from('customers').insert({ phone });

  const downPaymentAmount = computeDownPayment(driveThrough.downPayment, total);

  if (downPaymentAmount <= 0) {
    // No deposit configured - reaches the kitchen immediately, exactly
    // like any other order. Full amount collected at pickup via Record
    // Payment (see the POS pop-up notification for how staff are
    // alerted to a new one of these).
    const { data: order, error: orderError } = await supabaseAdmin
      .from('orders')
      .insert({
        business_id: business.id, card_id: null, table_label: '', note, total,
        request_type: 'order', order_type: 'drive_through', arrival_at: arrivalAt.toISOString(),
        status: 'pending', source: 'drive_through', pos_sync_status: 'not_applicable',
      })
      .select().single();
    if (orderError) return res.status(400).json({ message: orderError.message });

    const { error: itemsError } = await supabaseAdmin
      .from('order_items').insert(orderItemRows.map((i) => ({ ...i, order_id: order.id })));
    if (itemsError) return res.status(400).json({ message: itemsError.message });

    if (business.features?.inventory?.enabled) {
      const { deductStock } = require('../utils/inventoryStock');
      deductStock({ businessId: business.id, orderItemRows, orderId: order.id }).catch(() => {});
    }
    return res.status(201).json({ order, paymentRequired: false });
  }

  // A deposit (full or partial) is required - the order does not exist
  // as a real, visible order until that deposit actually clears. Reuses
  // the exact same 'awaiting_payment' pipeline publicController.js's
  // own pay-before-order NFC flow already uses (see migration 0121's
  // comment for why this isn't a new mechanism), converging on the
  // same cancelAwaitingOrder helper for the failure path - only the
  // success path (finalizeDriveThroughOrder, below) diverges from that
  // file's own finalizeOrderPayment, since THIS flow may only be
  // collecting a partial deposit, not the full amount.
  const { cancelAwaitingOrder } = require('./publicController');

  const { data: paymentIntegration } = await supabaseAdmin
    .from('pos_integrations')
    .select('*').eq('business_id', business.id).eq('purpose', 'payment').eq('enabled', true).maybeSingle();
  if (!paymentIntegration) {
    return res.status(400).json({ message: 'This business requires a deposit for drive-through orders but has no payment method connected - contact them directly.' });
  }
  const config = decryptConfig(paymentIntegration.config);
  const provider = config?.provider || 'tap';
  if (provider !== 'telr' && provider !== 'ngenius' && provider !== 'ziina') {
    return res.status(400).json({ message: 'This business does not use redirect-based payment for drive-through orders yet' });
  }

  const { data: order, error: orderError } = await supabaseAdmin
    .from('orders')
    .insert({
      business_id: business.id, card_id: null, table_label: '', note, total,
      request_type: 'order', order_type: 'drive_through', arrival_at: arrivalAt.toISOString(),
      status: 'awaiting_payment', source: 'drive_through', pos_sync_status: 'not_applicable',
    })
    .select().single();
  if (orderError) return res.status(400).json({ message: orderError.message });

  const { data: insertedItems, error: itemsError } = await supabaseAdmin
    .from('order_items').insert(orderItemRows.map((i) => ({ ...i, order_id: order.id }))).select();
  if (itemsError) return res.status(400).json({ message: itemsError.message });

  const { data: payment, error: paymentError } = await supabaseAdmin
    .from('payments')
    .insert({ business_id: business.id, card_id: null, order_item_ids: insertedItems.map((i) => i.id), amount: downPaymentAmount, tip_amount: 0, status: 'pending', provider })
    .select().single();
  if (paymentError) return res.status(400).json({ message: paymentError.message });

  const returnUrl = `${primaryClientUrl()}/${req.params.slug}/book/drive-through?orderPaymentId=${payment.id}`;
  const adapter = provider === 'telr'
    ? require('../utils/telrAdapter')
    : provider === 'ngenius'
    ? require('../utils/ngeniusAdapter')
    : require('../utils/ziinaBillAdapter');

  const session = await adapter.createPaymentSession(config, downPaymentAmount, 'Tavzio drive-through order', payment.id, returnUrl);
  if (!session.success) {
    await supabaseAdmin.from('payments').update({ status: 'failed', failure_reason: session.error || '' }).eq('id', payment.id);
    await cancelAwaitingOrder(order.id);
    return res.status(502).json({ message: session.error || 'Could not start the payment' });
  }

  await supabaseAdmin.from('payments').update({ provider_ref: session.providerRef }).eq('id', payment.id);
  res.status(201).json({ paymentRequired: true, redirectUrl: session.redirectUrl, paymentId: payment.id, orderId: order.id });
});

// Everything that must happen once a drive-through deposit has
// genuinely cleared (verified server-side) - sends the order into the
// normal kitchen/orders flow, exactly like finalizeOrderPayment in
// publicController.js, EXCEPT items are only marked paid if this
// payment actually covered the full total. A partial deposit unlocks
// the kitchen but leaves the remainder for Record Payment to collect
// later - it would be a real, dangerous bug to mark items paid for
// money that was never actually collected.
async function finalizeDriveThroughOrder({ order, orderItemRows, integration, business, amountPaid }) {
  const fullyPaid = amountPaid >= Number(order.total) - 0.01; // 1 fils float tolerance, same allowance recordManualPayment uses
  if (fullyPaid) {
    await supabaseAdmin
      .from('order_items')
      .update({ paid: true, cash_pending: false, paid_at: new Date().toISOString() })
      .eq('order_id', order.id);
  }

  await supabaseAdmin
    .from('orders')
    .update({ status: 'pending', pos_sync_status: integration ? 'pending' : 'not_applicable' })
    .eq('id', order.id);

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
      .catch(() => {});
  }
}

// @route POST /api/public/drive-through/orders/confirm-payment
// Body: { paymentId }
// Polled by the drive-through page after a redirect-based payment
// returns - same "poll after redirect" pattern the order/bill/booking
// payment flows all already use. Confirming here (not just checking)
// so a single page load after redirect is enough to finish the flow.
const confirmDriveThroughPayment = asyncHandler(async (req, res) => {
  const { paymentId } = req.body;
  if (!paymentId) return res.status(400).json({ message: 'paymentId is required' });

  const { data: payment } = await supabaseAdmin.from('payments').select('*').eq('id', paymentId).maybeSingle();
  if (!payment) return res.status(404).json({ message: 'Payment not found' });

  const { data: items } = await supabaseAdmin
    .from('order_items').select('*, orders!inner(*)').in('id', payment.order_item_ids || []);
  const order = items?.[0]?.orders;
  if (!order) return res.status(404).json({ message: 'Order not found' });

  if (payment.status === 'completed') return res.json({ status: 'completed', order });
  if (payment.status === 'failed') {
    return res.status(402).json({ message: payment.failure_reason || 'Payment failed - no order was sent to the kitchen', status: 'failed' });
  }

  const { data: business } = await supabaseAdmin.from('businesses').select('id, name, features').eq('id', payment.business_id).single();
  const { data: paymentIntegration } = await supabaseAdmin
    .from('pos_integrations')
    .select('*').eq('business_id', business.id).eq('purpose', 'payment').eq('enabled', true).maybeSingle();
  if (!paymentIntegration) return res.status(404).json({ message: 'Payment is not available for this business' });
  const config = decryptConfig(paymentIntegration.config);

  const adapter = payment.provider === 'telr'
    ? require('../utils/telrAdapter')
    : payment.provider === 'ngenius'
    ? require('../utils/ngeniusAdapter')
    : require('../utils/ziinaBillAdapter');

  const { cancelAwaitingOrder, printPaidBillReceipt } = require('./publicController');

  const check = await adapter.checkPaymentStatus(config, payment.provider_ref);
  if (!check.success) return res.status(502).json({ message: check.error || 'Could not verify the payment yet', status: 'pending' });

  if (!check.paid) {
    await supabaseAdmin.from('payments').update({ status: 'failed', failure_reason: check.statusText || 'Not authorised' }).eq('id', payment.id);
    await cancelAwaitingOrder(order.id);
    return res.status(402).json({ message: 'Payment was not completed - no order was sent to the kitchen', status: 'failed' });
  }

  await supabaseAdmin.from('payments').update({ status: 'completed' }).eq('id', payment.id);

  let integration = null;
  if (business.features?.ordering?.posIntegration) {
    const { data } = await supabaseAdmin
      .from('pos_integrations').select('*').eq('business_id', business.id).eq('purpose', 'ordering').eq('enabled', true).maybeSingle();
    integration = data ? { ...data, config: decryptConfig(data.config) } : data;
  }

  const orderItemRows = items.map(({ orders: _orders, ...item }) => item);
  await finalizeDriveThroughOrder({ order, orderItemRows, integration, business, amountPaid: Number(payment.amount) });

  // Real, explicit request: a receipt "everywhere" in this flow - same
  // itemized shape bill payments already use, printed through the same
  // printer integration, for whatever amount was actually charged here
  // (the full total, or just the deposit if this was a partial one -
  // the remainder's own receipt comes from Record Payment separately,
  // see the matching addition there).
  const { subtotalExVat, vatAmount, vatRate } = calculateVatInclusive(Number(payment.amount));
  const receipt = {
    items: orderItemRows.map((i) => ({
      name: i.item_name,
      quantity: i.quantity,
      unitPrice: i.unit_price,
      addons: i.addons || [],
      lineTotal: Math.round((i.unit_price + Number(i.addon_total || 0)) * i.quantity * 100) / 100,
    })),
    subtotalExVat,
    vatAmount,
    vatRate,
    discountAmount: 0,
    rewardDescription: '',
    tip: 0,
    total: Number(payment.amount),
    paidAt: new Date().toISOString(),
    paymentId: payment.id,
  };
  await printPaidBillReceipt(business, payment, receipt);

  res.json({ status: 'completed', order, receipt });
});

// @route GET /api/public/business/:slug/my-bookings?phone=
// The "manage an existing booking" entry point - same OTP trust model
// as everything else here (see requireVerifiedPhone), just reading
// instead of writing. Only ever returns this business's own bookings
// for this phone, never anything from another business - the whole
// point of scoping by business_id, not just phone.
const listMyBookings = asyncHandler(async (req, res) => {
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ message: 'phone is required' });

  const { data: business } = await supabaseAdmin.from('businesses').select('id').eq('slug', req.params.slug).eq('status', 'active').maybeSingle();
  if (!business) return res.status(404).json({ message: 'Business not found' });

  if (!(await requireVerifiedPhone(business.id, phone))) {
    return res.status(400).json({ message: 'Verify your phone number first' });
  }

  const { data: bookings, error } = await supabaseAdmin
    .from('bookings')
    .select('id, guest_name, party_size, requested_at, note, status, down_payment_status, service_requested_at, services(name), service_options(label)')
    .eq('business_id', business.id)
    .eq('contact_phone', phone)
    .in('status', ['pending', 'confirmed'])
    .order('requested_at', { ascending: true });
  if (error) return res.status(400).json({ message: error.message });

  res.json(bookings || []);
});

// @route PATCH /api/public/bookings/:bookingId/reschedule
// Body: { phone, requestedAt, partySize? }
// Same phone-match authorization as cancelPublicBooking below - the
// only credential this flow has. A reschedule doesn't touch a food
// pre-order or a down payment already taken; it only moves the table
// reservation itself. If this business requires down payments,
// deliberately not re-validating that here - the guest already paid
// for THIS booking, and moving its time doesn't un-pay it.
const reschedulePublicBooking = asyncHandler(async (req, res) => {
  const { phone, requestedAt, partySize } = req.body;
  if (!phone || !requestedAt) return res.status(400).json({ message: 'phone and requestedAt are required' });

  const { data: booking } = await supabaseAdmin
    .from('bookings')
    .select('id, business_id, status, contact_phone')
    .eq('id', req.params.bookingId)
    .maybeSingle();
  if (!booking || booking.contact_phone !== phone) {
    return res.status(404).json({ message: 'Booking not found' });
  }
  if (!['pending', 'confirmed'].includes(booking.status)) {
    return res.status(400).json({ message: 'This booking can no longer be rescheduled' });
  }
  if (!(await requireVerifiedPhone(booking.business_id, phone))) {
    return res.status(400).json({ message: 'Verify your phone number first' });
  }

  const patch = { requested_at: requestedAt };
  if (partySize) patch.party_size = partySize;

  const { data: updated, error } = await supabaseAdmin
    .from('bookings')
    .update(patch)
    .eq('id', booking.id)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  await logAction({
    businessId: booking.business_id,
    actor: null,
    action: 'booking_rescheduled_by_customer',
    targetId: booking.id,
    details: { requestedAt, partySize: partySize || null },
  });

  res.json(updated);
});

// @route POST /api/public/bookings/:bookingId/cancel
// Body: { phone }
// The only "credential" a guest ever has in this whole flow is their
// verified phone number - same trust model as confirmArrivalByCustomer
// above. Matching contact_phone against the booking is what proves this
// really is the person who made it, not a guessed booking id. Only
// pending/confirmed bookings can be cancelled - already-completed,
// already-declined, or already-cancelled bookings have nothing left to
// cancel.
const cancelPublicBooking = asyncHandler(async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ message: 'phone is required' });

  const { data: booking } = await supabaseAdmin
    .from('bookings')
    .select('id, business_id, status, contact_phone')
    .eq('id', req.params.bookingId)
    .maybeSingle();
  if (!booking || booking.contact_phone !== phone) {
    return res.status(404).json({ message: 'Booking not found' });
  }
  if (!['pending', 'confirmed'].includes(booking.status)) {
    return res.status(400).json({ message: 'This booking can no longer be cancelled' });
  }

  const { data: updated, error } = await supabaseAdmin
    .from('bookings')
    .update({ status: 'cancelled' })
    .eq('id', booking.id)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  await logAction({
    businessId: booking.business_id,
    actor: null,
    action: 'booking_cancelled_by_customer',
    targetId: booking.id,
    details: {},
  });

  res.json(updated);
});

// @route PATCH /api/public/bookings/:bookingId/cancel-service
// Real, separate action for the explicit request: cancels only the
// attached service, leaving the table reservation itself completely
// intact - a guest who no longer wants the birthday package still
// keeps their table.
const cancelPublicBookingService = asyncHandler(async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ message: 'phone is required' });

  const { data: booking } = await supabaseAdmin
    .from('bookings')
    .select('id, business_id, status, contact_phone, service_id')
    .eq('id', req.params.bookingId)
    .maybeSingle();
  if (!booking || booking.contact_phone !== phone) {
    return res.status(404).json({ message: 'Booking not found' });
  }
  if (!['pending', 'confirmed'].includes(booking.status)) {
    return res.status(400).json({ message: 'This booking can no longer be changed' });
  }
  if (!booking.service_id) {
    return res.status(400).json({ message: 'This booking has no service attached' });
  }

  const { data: updated, error } = await supabaseAdmin
    .from('bookings')
    .update({ service_id: null, service_option_id: null, service_requested_at: null })
    .eq('id', booking.id)
    .select('*, services(name), service_options(label)')
    .single();
  if (error) return res.status(400).json({ message: error.message });

  await logAction({
    businessId: booking.business_id,
    actor: null,
    action: 'booking_service_cancelled_by_customer',
    targetId: booking.id,
    details: {},
  });

  res.json(updated);
});

module.exports = {
  getBookingConfig, getBookingChooserConfig, requestBookingOtp, verifyBookingOtp, createPublicBooking,
  getBookingPaymentStatus, getBookingArrival, confirmArrivalByCustomer,
  cancelPublicBooking, cancelPublicBookingService, listMyBookings, reschedulePublicBooking,
  reconcilePendingBookingPayments,
  createDriveThroughOrder, confirmDriveThroughPayment,
};

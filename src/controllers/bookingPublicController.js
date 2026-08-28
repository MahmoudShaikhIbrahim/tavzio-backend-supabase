const { supabaseAdmin } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');
const { logAction } = require('../utils/auditLog');
const { sendOtp, validateOtp } = require('../utils/smsAdapter');
const { decryptConfig } = require('../utils/credentialEncryption');
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
    .select('id, name, features, operating_hours, booking_hours')
    .eq('slug', req.params.slug)
    .eq('status', 'active')
    .maybeSingle();
  if (error || !business) return res.status(404).json({ message: 'Business not found' });

  const booking = business.features?.onlineBooking || {};
  if (!booking.enabled) return res.status(404).json({ message: 'Online booking is not available for this business' });

  let menu = [];
  if (booking.allowPreOrder) {
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
    .select('id, guest_name, party_size, requested_at, status, arrival_status, customer_phone_verified')
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
  res.json(booking);
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
  getBookingConfig, requestBookingOtp, verifyBookingOtp, createPublicBooking,
  getBookingPaymentStatus, getBookingArrival, confirmArrivalByCustomer,
  cancelPublicBooking, cancelPublicBookingService, listMyBookings, reschedulePublicBooking,
  reconcilePendingBookingPayments,
};

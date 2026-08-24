const express = require('express');
const rateLimit = require('express-rate-limit');
const { submitLead } = require('../controllers/leadController');
const { getDemoMenu, placeDemoOrder, getDemoOrders, markDemoOrderReady, payDemoOrder } = require('../controllers/demoController');
const { getGuestPortal, submitGuestRequest, submitGuestOrder, getMyRequests } = require('../controllers/hotelGuestPortalController');
const { listPublicOutlets } = require('../controllers/hotelOutletsController');
const { submitCustomButtonRequest } = require('../controllers/customButtonController');
const { createFolioPaymentSession, confirmFolioPayment } = require('../controllers/hotelPaymentController');
const {
  getBookingConfig, requestBookingOtp, verifyBookingOtp, createPublicBooking,
  getBookingPaymentStatus, getBookingArrival, confirmArrivalByCustomer,
  cancelPublicBooking, listMyBookings, reschedulePublicBooking,
} = require('../controllers/bookingPublicController');
const {
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
  getBill,
  markItemsCashPending,
  payBill,
  createPaySession,
  confirmPaySession,
  cancelBillPaySession,
} = require('../controllers/publicController');

const router = express.Router();

router.get('/tap/:cardUid', resolveCardTap);
router.get('/business/:slug', getPublicBusiness);
router.post('/business/:slug/event', logPublicEvent);
router.post('/business/:slug/loyalty/checkin', loyaltyCheckin);
router.get('/business/:slug/loyalty/status', loyaltyStatus);
router.post('/business/:slug/loyalty/claim', claimReward);
router.get('/business/:slug/menu', getPublicMenu);
router.post('/business/:slug/orders', submitOrder);
router.post('/business/:slug/orders/pay', payOrder);
router.post('/business/:slug/orders/pay-session', createOrderPaySession);
router.post('/business/:slug/orders/confirm-payment', confirmOrderPayment);
router.post('/business/:slug/orders/pay-cash', payOrderWithCash);
router.post('/business/:slug/orders/:orderId/cancel-payment', cancelOrderPayment);
// Real fix: the old service-appointment booking flow (salon/spa style)
// used to be mounted at this exact path via getPublicServices/
// submitBooking - both retired here since the new online-booking flow
// below (getBookingConfig/createPublicBooking) now owns this route,
// and Express matches routes in registration order, so leaving both
// registered would have silently made the new one unreachable forever.
// Confirmed via search: getServices/submitBooking on the frontend were
// only ever called from BookingPage.tsx, which is being rewritten to
// use the new flow - nothing else depended on the old path.
router.get('/business/:slug/bill', getBill);
router.post('/business/:slug/bill/cash-pending', markItemsCashPending);
router.post('/business/:slug/bill/pay', payBill);
router.post('/business/:slug/bill/pay-session', createPaySession);
router.post('/business/:slug/bill/confirm', confirmPaySession);
router.post('/business/:slug/bill/cancel', cancelBillPaySession);
router.post('/business/:slug/custom-buttons/:buttonId/request', submitCustomButtonRequest);

router.post('/leads', submitLead);

router.get('/hotel/:slug/room/:roomId', getGuestPortal);
router.get('/hotel/:slug/room/:roomId/outlets', listPublicOutlets);
router.post('/hotel/:slug/room/:roomId/requests', submitGuestRequest);
router.post('/hotel/:slug/room/:roomId/orders', submitGuestOrder);
router.get('/hotel/:slug/room/:roomId/my-requests', getMyRequests);
router.post('/hotel/:slug/room/:roomId/folio/pay', createFolioPaymentSession);
router.post('/hotel/:slug/room/:roomId/folio/confirm', confirmFolioPayment);

// Real fix: a lobby/reception/unassigned stand has no room to bind to,
// so it can never charge a folio or place a room-service order (there's
// no bill to attach them to) - but it still needs Guest Portal Services
// and Landing Page Buttons on the same one page. These reuse the exact
// same controller functions as the room-bound routes above; roomId is
// simply absent from req.params, which resolveGuestContext already
// treats as "no room" rather than an error.
router.get('/hotel/:slug/hotel-portal', getGuestPortal);
router.post('/hotel/:slug/hotel-portal/requests', submitGuestRequest);
router.get('/hotel/:slug/hotel-portal/my-requests', getMyRequests);

// Marketing demo (/demo on the frontend) - no auth, fully sandboxed,
// touches nothing outside demo_menu_items/demo_orders/demo_order_items.
router.get('/demo/menu', getDemoMenu);
router.post('/demo/orders', placeDemoOrder);
router.get('/demo/orders', getDemoOrders);
router.patch('/demo/orders/:orderId/ready', markDemoOrderReady);
router.post('/demo/orders/:orderId/pay', payDemoOrder);

// Online booking - a dedicated, much stricter limiter on the OTP
// request route specifically: unlike the general 60/min publicLimiter
// already applied to everything under /api/public, each OTP request
// sends a real SMS that costs real money, and is a classic abuse
// target (SMS-bombing a stranger's number) if left at the general
// limit.
const bookingOtpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5 });
router.get('/business/:slug/booking-config', getBookingConfig);
router.post('/business/:slug/booking-otp/request', bookingOtpLimiter, requestBookingOtp);
router.post('/business/:slug/booking-otp/verify', verifyBookingOtp);
router.post('/business/:slug/bookings', createPublicBooking);
router.get('/bookings/:bookingId/status', getBookingPaymentStatus);
router.get('/bookings/:bookingId/arrival', getBookingArrival);
router.post('/bookings/:bookingId/confirm-arrival', confirmArrivalByCustomer);
router.post('/bookings/:bookingId/cancel', cancelPublicBooking);
router.get('/business/:slug/my-bookings', listMyBookings);
router.patch('/bookings/:bookingId/reschedule', reschedulePublicBooking);

module.exports = router;

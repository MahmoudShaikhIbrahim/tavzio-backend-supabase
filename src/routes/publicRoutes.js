const express = require('express');
const { submitLead } = require('../controllers/leadController');
const { getGuestPortal, submitGuestRequest, submitGuestOrder, getMyRequests } = require('../controllers/hotelGuestPortalController');
const { listPublicOutlets } = require('../controllers/hotelOutletsController');
const { submitCustomButtonRequest } = require('../controllers/customButtonController');
const { createFolioPaymentSession, confirmFolioPayment } = require('../controllers/hotelPaymentController');
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
  getPublicServices,
  submitBooking,
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
router.get('/business/:slug/services', getPublicServices);
router.post('/business/:slug/bookings', submitBooking);
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

module.exports = router;

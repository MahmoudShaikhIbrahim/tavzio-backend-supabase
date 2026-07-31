const express = require('express');
const {
  resolveCardTap,
  getPublicBusiness,
  logPublicEvent,
  loyaltyCheckin,
  loyaltyStatus,
  claimReward,
  getPublicMenu,
  submitOrder,
  getPublicServices,
  submitBooking,
  getBill,
  markItemsCashPending,
  payBill,
  createPaySession,
  confirmPaySession,
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
router.get('/business/:slug/services', getPublicServices);
router.post('/business/:slug/bookings', submitBooking);
router.get('/business/:slug/bill', getBill);
router.post('/business/:slug/bill/cash-pending', markItemsCashPending);
router.post('/business/:slug/bill/pay', payBill);
router.post('/business/:slug/bill/pay-session', createPaySession);
router.post('/business/:slug/bill/confirm', confirmPaySession);

module.exports = router;

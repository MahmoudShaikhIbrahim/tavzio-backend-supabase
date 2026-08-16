const express = require('express');
const { getSummary, getCardBreakdown, getSalesByChannel, getTopItems, getRevenueTrend, getPeakHours, getKitchenPerformance, getHotelPerformance } = require('../controllers/analyticsController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/summary', getSummary);
router.get('/cards', getCardBreakdown);
router.get('/sales-by-channel', getSalesByChannel);
router.get('/top-items', getTopItems);
router.get('/revenue-trend', getRevenueTrend);
router.get('/peak-hours', getPeakHours);
router.get('/kitchen-performance', getKitchenPerformance);
router.get('/hotel-performance', getHotelPerformance);

module.exports = router;

const express = require('express');
const { getSummary, getCardBreakdown, getSalesByChannel } = require('../controllers/analyticsController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/summary', getSummary);
router.get('/cards', getCardBreakdown);
router.get('/sales-by-channel', getSalesByChannel);

module.exports = router;

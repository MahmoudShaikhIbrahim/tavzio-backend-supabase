const express = require('express');
const { getSummary, getCardBreakdown } = require('../controllers/analyticsController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/summary', getSummary);
router.get('/cards', getCardBreakdown);

module.exports = router;

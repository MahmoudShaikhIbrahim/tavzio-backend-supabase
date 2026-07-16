const express = require('express');
const { getPaymentIntegration, upsertPaymentIntegration, getPaymentStatus } = require('../controllers/paymentController');
const { protect, authorize, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

// business_owner only - RLS backs this up independently (see migration 0009)
router.get('/', authorize('business_owner'), getPaymentIntegration);
router.put('/', authorize('business_owner'), upsertPaymentIntegration);

// owner, staff, and super_admin can all see connected/not-connected
router.get('/status', getPaymentStatus);

module.exports = router;

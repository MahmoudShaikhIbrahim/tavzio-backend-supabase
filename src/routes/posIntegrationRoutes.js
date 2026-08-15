const express = require('express');
const { getIntegration, upsertIntegration, getIntegrationStatus, toggleIntegrationEnabled } = require('../controllers/posIntegrationController');
const { protect, authorize, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

// business_owner configures their own integration directly, same
// self-service pattern as the payment gateway settings - super_admin
// can also reach it to help set one up on a business's behalf.
router.get('/', authorize('business_owner', 'super_admin'), getIntegration);
router.put('/', authorize('business_owner', 'super_admin'), upsertIntegration);

// owner/staff-safe - no credentials exposed, only ever flips enabled/disabled
router.patch('/toggle', toggleIntegrationEnabled);
router.get('/status', getIntegrationStatus);

module.exports = router;

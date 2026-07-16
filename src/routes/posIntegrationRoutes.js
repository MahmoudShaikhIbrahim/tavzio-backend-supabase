const express = require('express');
const { getIntegration, upsertIntegration, getIntegrationStatus, toggleIntegrationEnabled } = require('../controllers/posIntegrationController');
const { protect, authorize, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

// super_admin only - full config including credentials
router.get('/', authorize('super_admin'), getIntegration);
router.put('/', authorize('super_admin'), upsertIntegration);

// owner/staff-safe - no credentials exposed, only ever flips enabled/disabled
router.patch('/toggle', toggleIntegrationEnabled);
router.get('/status', getIntegrationStatus);

module.exports = router;

const express = require('express');
const {
  getPrinterIntegration, listAvailablePrinters, upsertPrinterIntegration, getPrinterStatus,
} = require('../controllers/printerController');
const { protect, authorize, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

// business_owner only - RLS backs this up independently (migration 0029)
router.get('/', authorize('business_owner'), getPrinterIntegration);
router.post('/printers', authorize('business_owner'), listAvailablePrinters);
router.put('/', authorize('business_owner'), upsertPrinterIntegration);

// owner, staff, and super_admin can all see connected/not-connected
router.get('/status', getPrinterStatus);

module.exports = router;

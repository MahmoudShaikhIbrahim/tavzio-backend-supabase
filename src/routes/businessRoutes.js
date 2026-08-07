const express = require('express');
const {
  getBusiness,
  updateBusiness,
  listBusinesses,
  setBusinessStatus,
  setBusinessFeatures,
  deleteBusiness,
} = require('../controllers/businessController');
const { getReceiptBranding, updateReceiptBranding } = require('../controllers/receiptController');
const { protect, authorize, enforceTenant } = require('../middleware/auth');
const cardRoutes = require('./cardRoutes');
const analyticsRoutes = require('./analyticsRoutes');
const loyaltyRoutes = require('./loyaltyRoutes');
const staffRoutes = require('./staffRoutes');
const menuRoutes = require('./menuRoutes');
const menuAiRoutes = require('./menuAiRoutes');
const notificationRoutes = require('./notificationRoutes');
const orderRoutes = require('./orderRoutes');
const posIntegrationRoutes = require('./posIntegrationRoutes');
const servicesRoutes = require('./servicesRoutes');
const bookingRoutes = require('./bookingRoutes');
const paymentRoutes = require('./paymentRoutes');
const paymentsListRoutes = require('./paymentsListRoutes');
const customButtonRoutes = require('./customButtonRoutes');
const auditLogRoutes = require('./auditLogRoutes');
const supportMessageRoutes = require('./supportMessageRoutes');
const receiptRoutes = require('./receiptRoutes');
const printerRoutes = require('./printerRoutes');
const tableReceiptRoutes = require('./tableReceiptRoutes');

const router = express.Router();

router.get('/', protect, authorize('super_admin'), listBusinesses);

// Platform-wide (not tied to any one business) - the currently-active
// stamp/signature/legal name new receipts will use going forward.
router.get('/receipt-branding', protect, authorize('super_admin'), getReceiptBranding);
router.put('/receipt-branding', protect, authorize('super_admin'), updateReceiptBranding);

router.get('/:businessId', protect, enforceTenant, getBusiness);
router.patch('/:businessId', protect, enforceTenant, updateBusiness);

router.patch('/:businessId/status', protect, authorize('super_admin'), setBusinessStatus);

// Feature toggles are now self-service for owner AND staff, not just
// super_admin - super_admin keeps identical access too, for help/override.
// RLS backs this up independently (see migration 0009's businesses UPDATE
// policy), so this isn't the only thing enforcing it.
router.patch('/:businessId/features', protect, authorize('super_admin', 'business_owner', 'staff'), setBusinessFeatures);

router.delete('/:businessId', protect, authorize('super_admin'), deleteBusiness);

router.use('/:businessId/cards', cardRoutes);
router.use('/:businessId/analytics', analyticsRoutes);
router.use('/:businessId/loyalty', loyaltyRoutes);
router.use('/:businessId/staff', staffRoutes);
router.use('/:businessId/menu', menuRoutes);
router.use('/:businessId/menu/ai', menuAiRoutes);
router.use('/:businessId/orders', orderRoutes);
router.use('/:businessId/notifications', notificationRoutes);
router.use('/:businessId/pos-integration', posIntegrationRoutes);
router.use('/:businessId/services', servicesRoutes);
router.use('/:businessId/bookings', bookingRoutes);
router.use('/:businessId/payment-integration', paymentRoutes);
router.use('/:businessId/payments', paymentsListRoutes);
router.use('/:businessId/custom-buttons', customButtonRoutes);
router.use('/:businessId/audit-log', auditLogRoutes);
router.use('/:businessId/messages', supportMessageRoutes);
router.use('/:businessId/receipts', receiptRoutes);
router.use('/:businessId/printer-integration', printerRoutes);
router.use('/:businessId/tables', tableReceiptRoutes);

module.exports = router;

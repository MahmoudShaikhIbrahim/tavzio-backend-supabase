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
const { listKitchenStationPrinters, upsertKitchenStationPrinter, deleteKitchenStationPrinter } = require('../controllers/kitchenPrinterController');
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
const contractRoutes = require('./contractRoutes');
const digitalCardRoutes = require('./digitalCardRoutes');
const inventoryRoutes = require('./inventoryRoutes');
const warehouseRoutes = require('./warehouseRoutes');
const stockTransferRoutes = require('./stockTransferRoutes');
const poAllocationRoutes = require('./poAllocationRoutes');
const tillRoutes = require('./tillRoutes');
const tableManagementRoutes = require('./tableManagementRoutes');
const waitlistRoutes = require('./waitlistRoutes');
const hotelRoutes = require('./hotelRoutes');
const { getDeliveryIntegration, upsertDeliveryIntegration } = require('../controllers/deliverectController');
const { getBusinessOrganization, appointOrgOwner, leaveOrganization, setOrgOwnerStatus } = require('../controllers/organizationController');
const printerRoutes = require('./printerRoutes');
const tableReceiptRoutes = require('./tableReceiptRoutes');

const router = express.Router();

router.get('/', protect, authorize('super_admin'), listBusinesses);

// Platform-wide audit report - must be registered before the /:businessId
// wildcard below, or "audit-report" would be swallowed as a businessId.
router.get('/audit-report/pdf', protect, authorize('super_admin'), require('../controllers/auditReportController').generatePlatformAuditReport);

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

// Self-service organizations - see organizationController.js's
// "Self-service" section for the full reasoning. Deliberately business-
// owner-scoped (not super_admin-only like the rest of organizationRoutes.js)
// since this can only ever create/appoint within the caller's own
// business, never touch another one.
router.get('/:businessId/organization', protect, enforceTenant, getBusinessOrganization);
router.post('/:businessId/organization/owner', protect, enforceTenant, authorize('business_owner', 'super_admin'), appointOrgOwner);
router.delete('/:businessId/organization', protect, enforceTenant, authorize('business_owner', 'super_admin'), leaveOrganization);
router.patch('/:businessId/organization/owner/:userId', protect, enforceTenant, authorize('business_owner', 'super_admin'), setOrgOwnerStatus);

router.use('/:businessId/cards', cardRoutes);
router.use('/:businessId/analytics', analyticsRoutes);
router.use('/:businessId/loyalty', loyaltyRoutes);
router.use('/:businessId/staff', staffRoutes);

router.get('/:businessId/kitchen-station-printers', protect, enforceTenant, listKitchenStationPrinters);
router.put('/:businessId/kitchen-station-printers', protect, enforceTenant, authorize('business_owner', 'super_admin'), upsertKitchenStationPrinter);
router.delete('/:businessId/kitchen-station-printers/:id', protect, enforceTenant, authorize('business_owner', 'super_admin'), deleteKitchenStationPrinter);
router.use('/:businessId/staff-shifts', require('./staffShiftRoutes'));
router.use('/:businessId/hr', require('./hrRoutes'));
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
router.use('/:businessId/contracts', contractRoutes);
router.use('/:businessId/digital-card', digitalCardRoutes);
router.use('/:businessId/inventory', inventoryRoutes);
router.use('/:businessId/warehouses', warehouseRoutes);
router.use('/:businessId/stock-transfers', stockTransferRoutes);
router.use('/:businessId/po-allocations', poAllocationRoutes);
router.use('/:businessId/till', tillRoutes);
router.use('/:businessId/tables-floor', tableManagementRoutes);
router.use('/:businessId/waitlist', waitlistRoutes);
router.use('/:businessId/hotel', hotelRoutes);
router.use('/:businessId/forecasting', require('./forecastingRoutes'));
router.use('/:businessId/payroll', require('./payrollRoutes'));
router.use('/:businessId/accounting', require('./accountingRoutes'));
router.use('/:businessId/channel-manager', require('./channelManagerRoutes'));
router.use('/:businessId/marketing', require('./marketingRoutes'));
router.post('/:businessId/payment-transactions/:txnId/refund', protect, enforceTenant, require('../controllers/hotelPaymentController').refundTransaction);
router.get('/:businessId/payment-reconciliation', protect, enforceTenant, require('../controllers/hotelPaymentController').getReconciliation);
router.get('/:businessId/external-hotel-systems', protect, enforceTenant, require('../controllers/externalHotelSystemsController').listExternalIntegrations);
router.put('/:businessId/external-hotel-systems/:provider', protect, enforceTenant, require('../controllers/externalHotelSystemsController').connectExternalIntegration);
router.delete('/:businessId/external-hotel-systems/:provider', protect, enforceTenant, require('../controllers/externalHotelSystemsController').disconnectExternalIntegration);
router.get('/:businessId/delivery-integration', protect, enforceTenant, getDeliveryIntegration);
router.put('/:businessId/delivery-integration', protect, enforceTenant, upsertDeliveryIntegration);
router.get('/:businessId/zoho-books/connect', protect, enforceTenant, authorize('business_owner', 'super_admin'), require('../controllers/zohoBooksController').getConnectUrl);
router.get('/:businessId/zoho-books/status', protect, enforceTenant, require('../controllers/zohoBooksController').getStatus);
router.delete('/:businessId/zoho-books', protect, enforceTenant, authorize('business_owner', 'super_admin'), require('../controllers/zohoBooksController').disconnect);
router.post('/:businessId/zoho-books/sync', protect, enforceTenant, authorize('business_owner', 'super_admin'), require('../controllers/zohoBooksController').syncReceipts);
router.get('/:businessId/audit-report/pdf', protect, enforceTenant, require('../controllers/auditReportController').generateBusinessAuditReport);
router.use('/:businessId/printer-integration', printerRoutes);
router.use('/:businessId/tables', tableReceiptRoutes);

module.exports = router;

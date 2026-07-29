const express = require('express');
const { listReceipts, createReceipt, voidReceipt, getReceiptPdf } = require('../controllers/receiptController');
const { protect, authorize, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

// Business owner/staff can view their own receipts and download the PDF;
// only super_admin can issue or void one.
router.get('/', protect, enforceTenant, authorize('super_admin', 'business_owner', 'staff'), listReceipts);
router.get('/:receiptId/pdf', protect, enforceTenant, authorize('super_admin', 'business_owner', 'staff'), getReceiptPdf);
router.post('/', protect, authorize('super_admin'), createReceipt);
router.delete('/:receiptId', protect, authorize('super_admin'), voidReceipt);

module.exports = router;

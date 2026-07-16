const express = require('express');
const { listPayments, exportPayments } = require('../controllers/exportController');
const { refundPayment } = require('../controllers/refundController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/export', exportPayments); // must come before /
router.get('/', listPayments);
router.post('/:paymentId/refund', refundPayment); // staff or owner - no extra role restriction beyond tenant membership

module.exports = router;

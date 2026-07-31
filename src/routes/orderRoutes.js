const express = require('express');
const {
  listOrders, updateOrderStatus, voidOrder, voidOrderItem, clearTable, placeStaffOrder, listRequests, dismissRequest,
  recordManualPayment,
} = require('../controllers/orderController');
const { exportOrders } = require('../controllers/exportController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/export', exportOrders); // must come before /:orderId
router.post('/clear-table', clearTable);
router.post('/staff-place', placeStaffOrder);
router.get('/requests', listRequests);
router.patch('/requests/:requestId/dismiss', dismissRequest);

router.get('/', listOrders);
router.patch('/:orderId', updateOrderStatus);
router.post('/:orderId/void', voidOrder);
router.post('/:orderId/items/:itemId/void', voidOrderItem);
router.post('/:orderId/manual-payment', recordManualPayment);

module.exports = router;

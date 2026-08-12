const express = require('express');
const {
  listOrders, updateOrderStatus, voidOrder, voidOrderItem, clearTable, placeStaffOrder, createPosOrder, confirmPosCardPayment, listRequests, dismissRequest,
  recordManualPayment, listCashPendingItems, ackOrderReady, fireCourse,
} = require('../controllers/orderController');
const { exportOrders } = require('../controllers/exportController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/export', exportOrders); // must come before /:orderId
router.post('/clear-table', clearTable);
router.post('/staff-place', placeStaffOrder);
router.post('/pos', createPosOrder);
router.post('/pos/confirm-card-payment', confirmPosCardPayment);
router.get('/requests', listRequests);
router.get('/cash-pending', listCashPendingItems);
router.patch('/requests/:requestId/dismiss', dismissRequest);

router.get('/', listOrders);
router.patch('/:orderId', updateOrderStatus);
router.post('/:orderId/void', voidOrder);
router.post('/:orderId/items/:itemId/void', voidOrderItem);
router.post('/:orderId/manual-payment', recordManualPayment);
router.post('/:orderId/ready-ack', ackOrderReady);
router.post('/:orderId/fire-course', fireCourse);

module.exports = router;

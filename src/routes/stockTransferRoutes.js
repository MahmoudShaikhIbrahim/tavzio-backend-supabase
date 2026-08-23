const express = require('express');
const {
  listStockTransfers, createStockTransfer, approveStockTransfer, shipStockTransfer, receiveStockTransfer, cancelStockTransfer,
} = require('../controllers/stockTransferController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/', listStockTransfers);
router.post('/', createStockTransfer);
router.patch('/:transferId/approve', approveStockTransfer);
router.patch('/:transferId/ship', shipStockTransfer);
router.patch('/:transferId/receive', receiveStockTransfer);
router.patch('/:transferId/cancel', cancelStockTransfer);

module.exports = router;

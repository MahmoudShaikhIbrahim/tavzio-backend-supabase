const express = require('express');
const { listTablesWithUnpaid, getTableReceipt, printTableReceipt } = require('../controllers/tableReceiptController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/', listTablesWithUnpaid);
router.get('/:cardId/receipt', getTableReceipt);
router.post('/:cardId/receipt/print', printTableReceipt);

module.exports = router;

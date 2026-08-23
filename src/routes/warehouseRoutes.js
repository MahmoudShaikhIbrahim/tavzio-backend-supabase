const express = require('express');
const { listWarehouses, createWarehouse, updateWarehouse, deleteWarehouse, getWarehouseStock } = require('../controllers/warehouseController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/', listWarehouses);
router.post('/', createWarehouse);
router.patch('/:warehouseId', updateWarehouse);
router.delete('/:warehouseId', deleteWarehouse);
router.get('/:warehouseId/stock', getWarehouseStock);

module.exports = router;

const express = require('express');
const { listPoAllocations, receivePoAllocation } = require('../controllers/poAllocationController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/', listPoAllocations);
router.post('/:allocationId/receive', receivePoAllocation);

module.exports = router;

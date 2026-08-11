const express = require('express');
const { listWaitlist, addToWaitlist, seatWaitlistEntry, cancelWaitlistEntry } = require('../controllers/tableManagementController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/', listWaitlist);
router.post('/', addToWaitlist);
router.post('/:entryId/seat', seatWaitlistEntry);
router.post('/:entryId/cancel', cancelWaitlistEntry);

module.exports = router;

const express = require('express');
const {
  listFloorTables, updateTableStatus, mergeTables, unmergeTable,
  listWaitlist, addToWaitlist, seatWaitlistEntry, cancelWaitlistEntry,
} = require('../controllers/tableManagementController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/', listFloorTables);
router.patch('/:cardId', updateTableStatus);
router.post('/:cardId/merge', mergeTables);
router.post('/:cardId/unmerge', unmergeTable);

module.exports = router;

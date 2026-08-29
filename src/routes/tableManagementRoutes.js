const express = require('express');
const {
  listTables, createTable, updateTable, deleteTable, connectCard, disconnectCard, mergeTables, unmergeTable,
  listWaitlist, addToWaitlist, seatWaitlistEntry, cancelWaitlistEntry,
  listFloorPlanCells, setFloorPlanCells,
} = require('../controllers/tableManagementController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/', listTables);
router.post('/', createTable);
router.patch('/:tableId', updateTable);
router.delete('/:tableId', deleteTable);
router.post('/:tableId/connect-card', connectCard);
router.post('/:tableId/disconnect-card', disconnectCard);
router.post('/:tableId/merge', mergeTables);
router.post('/:tableId/unmerge', unmergeTable);

router.get('/cells', listFloorPlanCells);
router.put('/cells', setFloorPlanCells);

module.exports = router;

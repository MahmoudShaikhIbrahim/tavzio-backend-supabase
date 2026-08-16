const express = require('express');
const { getMyOpenShift, clockIn, clockOut, listShifts, listMySchedule } = require('../controllers/staffShiftController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/mine', getMyOpenShift);
router.get('/my-schedule', listMySchedule);
router.post('/clock-in', clockIn);
router.post('/clock-out', clockOut);
router.get('/', listShifts);

module.exports = router;

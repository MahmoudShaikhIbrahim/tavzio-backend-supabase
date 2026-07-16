const express = require('express');
const { listBookings, updateBookingStatus } = require('../controllers/bookingController');
const { exportBookings } = require('../controllers/exportController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/export', exportBookings); // must come before /:bookingId
router.get('/', listBookings);
router.patch('/:bookingId', updateBookingStatus);

module.exports = router;

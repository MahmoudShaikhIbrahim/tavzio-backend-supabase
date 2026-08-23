const express = require('express');
const { listBookings, createBooking, updateBookingStatus, confirmArrivalByStaff } = require('../controllers/bookingController');
const { exportBookings } = require('../controllers/exportController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/export', exportBookings); // must come before /:bookingId
router.get('/', listBookings);
router.post('/', createBooking);
router.patch('/:bookingId', updateBookingStatus);
router.post('/:bookingId/confirm-arrival', confirmArrivalByStaff);

module.exports = router;

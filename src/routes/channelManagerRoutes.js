const express = require('express');
const {
  listChannelConnections, upsertChannelConnection, disconnectChannel,
  pushRatesToChannel, listRateSyncStatus,
  listChannelBookings, confirmChannelBooking, rejectChannelBooking,
} = require('../controllers/channelManagerController');
const { protect, authorize, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant, authorize('business_owner', 'super_admin'));

router.get('/connections', listChannelConnections);
router.put('/connections/:channel', upsertChannelConnection);
router.delete('/connections/:channel', disconnectChannel);

router.post('/push-rates', pushRatesToChannel);
router.get('/rate-sync-status', listRateSyncStatus);

router.get('/bookings', listChannelBookings);
router.patch('/bookings/:bookingId/confirm', confirmChannelBooking);
router.patch('/bookings/:bookingId/reject', rejectChannelBooking);

module.exports = router;

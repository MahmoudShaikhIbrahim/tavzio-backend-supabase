const express = require('express');
const { listRooms, createRoom, updateRoom } = require('../controllers/hotelRoomsController');
const { listGuests, createGuest, updateGuest } = require('../controllers/hotelGuestsController');
const { listReservations, createReservation, checkIn, checkOut, cancelReservation } = require('../controllers/hotelReservationsController');
const {
  getFolio, getFoliosByReservation, addCharge, recordPayment,
  recordDeposit, recordRefund, recordAdjustment, splitFolio, transferCharge, lookupFolioByRoom, getTourismDirhamReport,
} = require('../controllers/hotelFolioController');
const { listRatePlans, createRatePlan, updateRatePlan } = require('../controllers/hotelRatePlansController');
const { getCurrentBusinessDate, runNightAudit, listNightAudits } = require('../controllers/hotelNightAuditController');
const { listHousekeepingTasks, createHousekeepingTask, updateHousekeepingTask } = require('../controllers/housekeepingController');
const { listMaintenanceTickets, createMaintenanceTicket, updateMaintenanceTicket, listGuestRequests, updateGuestRequest } = require('../controllers/maintenanceController');
const { listOutlets, createOutlet, updateOutlet, deleteOutlet, setOutletItems } = require('../controllers/hotelOutletsController');
const { listBookingGroups, createBookingGroup, updateBookingGroup, deleteBookingGroup } = require('../controllers/hotelBookingGroupsController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });
router.use(protect, enforceTenant);

router.get('/rooms', listRooms);
router.post('/rooms', createRoom);
router.patch('/rooms/:roomId', updateRoom);

router.get('/guests', listGuests);
router.post('/guests', createGuest);
router.patch('/guests/:guestId', updateGuest);

router.get('/reservations', listReservations);
router.post('/reservations', createReservation);
router.post('/reservations/:reservationId/checkin', checkIn);
router.post('/reservations/:reservationId/checkout', checkOut);
router.post('/reservations/:reservationId/cancel', cancelReservation);

router.get('/folios/by-reservation/:reservationId', getFoliosByReservation);
router.get('/folios/lookup', lookupFolioByRoom);
router.get('/tourism-dirham-report', getTourismDirhamReport);
router.get('/folios/:folioId', getFolio);
router.post('/folios/:folioId/charges', addCharge);
router.post('/folios/:folioId/payments', recordPayment);
router.post('/folios/:folioId/deposit', recordDeposit);
router.post('/folios/:folioId/refund', recordRefund);
router.post('/folios/:folioId/adjustment', recordAdjustment);
router.post('/folios/:folioId/split', splitFolio);
router.post('/folios/:folioId/transfer-charge', transferCharge);

router.get('/rate-plans', listRatePlans);
router.post('/rate-plans', createRatePlan);
router.patch('/rate-plans/:ratePlanId', updateRatePlan);

router.get('/business-date', getCurrentBusinessDate);
router.post('/night-audit/run', runNightAudit);
router.get('/night-audit', listNightAudits);

router.get('/housekeeping', listHousekeepingTasks);
router.post('/housekeeping', createHousekeepingTask);
router.patch('/housekeeping/:taskId', updateHousekeepingTask);

router.get('/maintenance', listMaintenanceTickets);
router.post('/maintenance', createMaintenanceTicket);
router.patch('/maintenance/:ticketId', updateMaintenanceTicket);

router.get('/guest-requests', listGuestRequests);
router.patch('/guest-requests/:requestId', updateGuestRequest);

router.get('/outlets', listOutlets);
router.post('/outlets', createOutlet);
router.patch('/outlets/:outletId', updateOutlet);
router.delete('/outlets/:outletId', deleteOutlet);
router.put('/outlets/:outletId/items', setOutletItems);

router.get('/booking-groups', listBookingGroups);
router.post('/booking-groups', createBookingGroup);
router.patch('/booking-groups/:groupId', updateBookingGroup);
router.delete('/booking-groups/:groupId', deleteBookingGroup);

module.exports = router;

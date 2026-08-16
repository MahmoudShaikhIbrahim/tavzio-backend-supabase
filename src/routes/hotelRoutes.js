const express = require('express');
const { listRooms, createRoom, updateRoom } = require('../controllers/hotelRoomsController');
const { listGuests, matchGuestByPhone, createGuest, updateGuest, getGuestStayHistory } = require('../controllers/hotelGuestsController');
const { listReservations, createReservation, checkIn, checkOut, cancelReservation, markNoShow, modifyReservation, transferRoom } = require('../controllers/hotelReservationsController');
const {
  getFolio, getFoliosByReservation, addCharge, deleteCharge, recordPayment,
  recordDeposit, recordRefund, recordAdjustment, splitFolio, transferCharge, lookupFolioByRoom, getTourismDirhamReport,
} = require('../controllers/hotelFolioController');
const { listRatePlans, createRatePlan, updateRatePlan } = require('../controllers/hotelRatePlansController');
const {
  listRateOverrides, setRateOverride, deleteRateOverride,
  listPricingRules, createPricingRule, updatePricingRule, deletePricingRule,
  getEffectiveRate, getOccupancyForecast,
} = require('../controllers/hotelRevenueController');
const { getCurrentBusinessDate, getNightAuditPreview, runNightAudit, listNightAudits } = require('../controllers/hotelNightAuditController');
const { listHousekeepingTasks, createHousekeepingTask, updateHousekeepingTask, getHousekeepingPerformance } = require('../controllers/housekeepingController');
const { listMaintenanceTickets, createMaintenanceTicket, updateMaintenanceTicket, getMaintenancePerformance, listGuestRequests, updateGuestRequest } = require('../controllers/maintenanceController');
const { listOutlets, createOutlet, updateOutlet, deleteOutlet, setOutletItems } = require('../controllers/hotelOutletsController');
const { listGuestServices, createGuestService, updateGuestService, deleteGuestService } = require('../controllers/hotelGuestPortalController');
const { listBookingGroups, createBookingGroup, updateBookingGroup, deleteBookingGroup } = require('../controllers/hotelBookingGroupsController');
const { listCityLedgerEntries, settleCityLedgerEntry } = require('../controllers/hotelCityLedgerController');
const {
  listEventSpaces, createEventSpace, updateEventSpace,
  listEvents, getEvent, createEvent, updateEvent,
  addEventCharge, recordEventPayment, deleteEventCharge,
  getPipelineSummary,
} = require('../controllers/hotelEventsController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });
router.use(protect, enforceTenant);

router.get('/rooms', listRooms);
router.post('/rooms', createRoom);
router.patch('/rooms/:roomId', updateRoom);

router.get('/guests', listGuests);
router.get('/guests/match', matchGuestByPhone);
router.post('/guests', createGuest);
router.patch('/guests/:guestId', updateGuest);
router.get('/guests/:guestId/stays', getGuestStayHistory);

router.get('/reservations', listReservations);
router.post('/reservations', createReservation);
router.post('/reservations/:reservationId/checkin', checkIn);
router.post('/reservations/:reservationId/checkout', checkOut);
router.post('/reservations/:reservationId/cancel', cancelReservation);
router.post('/reservations/:reservationId/no-show', markNoShow);
router.patch('/reservations/:reservationId', modifyReservation);
router.post('/reservations/:reservationId/transfer-room', transferRoom);

router.get('/folios/by-reservation/:reservationId', getFoliosByReservation);
router.get('/folios/lookup', lookupFolioByRoom);
router.get('/tourism-dirham-report', getTourismDirhamReport);
router.get('/folios/:folioId', getFolio);
router.post('/folios/:folioId/charges', addCharge);
router.delete('/folios/:folioId/charges/:chargeId', deleteCharge);
router.post('/folios/:folioId/payments', recordPayment);
router.post('/folios/:folioId/deposit', recordDeposit);
router.post('/folios/:folioId/refund', recordRefund);
router.post('/folios/:folioId/adjustment', recordAdjustment);
router.post('/folios/:folioId/split', splitFolio);
router.post('/folios/:folioId/transfer-charge', transferCharge);

router.get('/rate-plans', listRatePlans);
router.post('/rate-plans', createRatePlan);
router.patch('/rate-plans/:ratePlanId', updateRatePlan);

router.get('/revenue/rate-overrides', listRateOverrides);
router.put('/revenue/rate-overrides', setRateOverride);
router.delete('/revenue/rate-overrides/:overrideId', deleteRateOverride);
router.get('/revenue/pricing-rules', listPricingRules);
router.post('/revenue/pricing-rules', createPricingRule);
router.patch('/revenue/pricing-rules/:ruleId', updatePricingRule);
router.delete('/revenue/pricing-rules/:ruleId', deletePricingRule);
router.get('/revenue/effective-rate', getEffectiveRate);
router.get('/revenue/occupancy-forecast', getOccupancyForecast);

router.get('/business-date', getCurrentBusinessDate);
router.post('/night-audit/run', runNightAudit);
router.get('/night-audit/preview', getNightAuditPreview);
router.get('/night-audit', listNightAudits);

router.get('/housekeeping', listHousekeepingTasks);
router.post('/housekeeping', createHousekeepingTask);
router.patch('/housekeeping/:taskId', updateHousekeepingTask);
router.get('/housekeeping-performance', getHousekeepingPerformance);

router.get('/maintenance', listMaintenanceTickets);
router.post('/maintenance', createMaintenanceTicket);
router.patch('/maintenance/:ticketId', updateMaintenanceTicket);
router.get('/maintenance-performance', getMaintenancePerformance);

router.get('/guest-requests', listGuestRequests);
router.patch('/guest-requests/:requestId', updateGuestRequest);

router.get('/outlets', listOutlets);
router.get('/guest-services', listGuestServices);
router.post('/guest-services', createGuestService);
router.patch('/guest-services/:serviceId', updateGuestService);
router.delete('/guest-services/:serviceId', deleteGuestService);
router.post('/outlets', createOutlet);
router.patch('/outlets/:outletId', updateOutlet);
router.delete('/outlets/:outletId', deleteOutlet);
router.put('/outlets/:outletId/items', setOutletItems);

router.get('/booking-groups', listBookingGroups);
router.post('/booking-groups', createBookingGroup);
router.patch('/booking-groups/:groupId', updateBookingGroup);
router.delete('/booking-groups/:groupId', deleteBookingGroup);

router.get('/city-ledger', listCityLedgerEntries);
router.post('/city-ledger/:entryId/settle', settleCityLedgerEntry);

router.get('/event-spaces', listEventSpaces);
router.post('/event-spaces', createEventSpace);
router.patch('/event-spaces/:spaceId', updateEventSpace);

router.get('/events', listEvents);
router.get('/events-pipeline-summary', getPipelineSummary);
router.get('/events/:eventId', getEvent);
router.post('/events', createEvent);
router.patch('/events/:eventId', updateEvent);
router.post('/events/:eventId/charges', addEventCharge);
router.post('/events/:eventId/payment', recordEventPayment);
router.delete('/events/:eventId/charges/:chargeId', deleteEventCharge);

module.exports = router;

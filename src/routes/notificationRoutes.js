const express = require('express');
const { getNotificationCounts, markSectionViewed } = require('../controllers/notificationController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/counts', getNotificationCounts);
router.post('/:section/mark-viewed', markSectionViewed);

module.exports = router;

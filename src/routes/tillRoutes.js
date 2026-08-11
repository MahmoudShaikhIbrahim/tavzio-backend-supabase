const express = require('express');
const { openTill, getMyOpenTill, closeTill, listTillSessions } = require('../controllers/tillController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/mine', getMyOpenTill);
router.post('/open', openTill);
router.post('/:tillId/close', closeTill);
router.get('/', listTillSessions);

module.exports = router;

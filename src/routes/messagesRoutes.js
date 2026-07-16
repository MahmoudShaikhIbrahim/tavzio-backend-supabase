const express = require('express');
const { getInbox } = require('../controllers/supportMessageController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

router.get('/inbox', protect, authorize('super_admin'), getInbox);

module.exports = router;

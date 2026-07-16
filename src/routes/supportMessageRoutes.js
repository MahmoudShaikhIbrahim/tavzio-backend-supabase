const express = require('express');
const { listMessages, sendMessage, markMessagesRead } = require('../controllers/supportMessageController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/', listMessages);
router.post('/', sendMessage);
router.patch('/read', markMessagesRead);

module.exports = router;

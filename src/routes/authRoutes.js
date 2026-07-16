const express = require('express');
const { register, login, refresh, me, confirmDevice } = require('../controllers/authController');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.post('/refresh', refresh);
router.get('/me', protect, me);
router.get('/confirm-device/:pendingId', confirmDevice);

module.exports = router;

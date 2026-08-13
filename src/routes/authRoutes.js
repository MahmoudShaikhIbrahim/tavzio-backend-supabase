const express = require('express');
const rateLimit = require('express-rate-limit');
const { register, login, refresh, me, updateMyTheme, confirmDevice, changePassword } = require('../controllers/authController');
const { listMyLinkedAccounts, createLinkedAccount, deleteLinkedAccount, switchAccount } = require('../controllers/linkedAccountsController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// Separate from the general apiLimiter applied to the whole /api/auth
// prefix in server.js - that one is shared with /refresh and /me, which
// fire automatically and often (every dashboard load, every 401 retry).
// A real person only submits login a handful of times per session, but
// heavy background refresh/profile-check traffic across several open
// tabs was able to exhaust the SHARED budget and then block an actual
// login attempt that had nothing to do with it. This dedicated limiter
// means login/register can never be starved out by that traffic - and
// at 20 attempts per 15 minutes per IP, it's still meaningfully tighter
// against real brute-force attempts than the shared 300 ever was.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

router.post('/register', loginLimiter, register);
router.post('/login', loginLimiter, login);
router.post('/refresh', refresh);
router.get('/me', protect, me);
router.patch('/theme', protect, updateMyTheme);
router.patch('/change-password', protect, loginLimiter, changePassword);
router.get('/confirm-device/:pendingId', confirmDevice);

router.get('/linked-accounts', protect, listMyLinkedAccounts);
router.post('/admin/linked-accounts', protect, authorize('super_admin'), createLinkedAccount);
router.delete('/linked-accounts/:linkId', protect, deleteLinkedAccount);
router.post('/switch-account', protect, loginLimiter, switchAccount);

module.exports = router;

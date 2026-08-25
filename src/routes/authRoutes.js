const express = require('express');
const rateLimit = require('express-rate-limit');
const { register, login, refresh, me, updateMyTheme, updateMyLanguage, updateMyTour, changeMyEmail, confirmDevice, changePassword, completeInvite } = require('../controllers/authController');
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

// Genuinely public, unauthenticated - login. Requires authentication
// only in the sense of the credentials themselves; there is no session
// yet at this point, so this is the one auth route that legitimately
// stays open to anyone.
router.post('/login', loginLimiter, login);
// register creates a new business + owner account. Its only real caller
// is the super_admin "Onboard a business" page - not a public self-serve
// signup flow. It was previously reachable by anyone unauthenticated,
// which is a real gap for an action that provisions a paid tenant on
// the platform: requiring super_admin here closes that, and is the
// correct fix for this specific route rather than a CAPTCHA widget,
// since the only legitimate caller is already logged in and a bot would
// just hit the raw endpoint directly, bypassing any UI widget anyway.
router.post('/register', protect, authorize('super_admin'), loginLimiter, register);
router.post('/refresh', refresh);
router.get('/me', protect, me);
router.patch('/theme', protect, updateMyTheme);
router.patch('/language', protect, updateMyLanguage);
router.patch('/tour', protect, updateMyTour);
router.patch('/change-password', protect, loginLimiter, changePassword);
router.post('/complete-invite', protect, completeInvite);
router.patch('/email', protect, loginLimiter, changeMyEmail);
router.get('/confirm-device/:pendingId', confirmDevice);

router.get('/linked-accounts', protect, listMyLinkedAccounts);
router.post('/admin/linked-accounts', protect, authorize('super_admin'), createLinkedAccount);
router.delete('/linked-accounts/:linkId', protect, deleteLinkedAccount);
router.post('/switch-account', protect, loginLimiter, switchAccount);

const { setPin, verifyPinEndpoint } = require('../controllers/pinController');
router.post('/pin', protect, loginLimiter, setPin);
router.post('/pin/verify', protect, loginLimiter, verifyPinEndpoint);

module.exports = router;

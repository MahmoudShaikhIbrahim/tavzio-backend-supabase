const express = require('express');
const { handleZiinaWebhook, registerZiinaWebhook } = require('../controllers/receiptController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// Public - Ziina itself calls this, there's no user session to check.
// Its own signature + IP-allowlist verification is the real gate here.
router.post('/webhook', handleZiinaWebhook);

// super_admin only - the deliberate, one-time action that points
// Ziina's account-wide webhook at Tavzio (see registerZiinaWebhook for
// why this is never triggered automatically).
router.post('/register-webhook', protect, authorize('super_admin'), registerZiinaWebhook);

module.exports = router;

const express = require('express');
const { handleStripeWebhook } = require('../controllers/stripeWebhookController');

const router = express.Router();

router.post('/webhook', handleStripeWebhook);

module.exports = router;

const express = require('express');
const {
  getPublicCard, trackCardEvent, downloadVCard, getCardQrPng, getCardQrSvg,
} = require('../controllers/digitalCardController');

const router = express.Router();

router.get('/:slug', getPublicCard);
router.post('/:slug/track', trackCardEvent);
router.get('/:slug/vcard', downloadVCard);
router.get('/:slug/qr.png', getCardQrPng);
router.get('/:slug/qr.svg', getCardQrSvg);

module.exports = router;

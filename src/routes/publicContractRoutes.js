const express = require('express');
const { getPublicContractByToken, signPublicContract, downloadPublicContractPdf, resumeContractCheckout } = require('../controllers/contractController');

const router = express.Router();

router.get('/:token', getPublicContractByToken);
router.get('/:token/pdf', downloadPublicContractPdf);
router.post('/:token/sign', signPublicContract);
router.post('/:token/resume-checkout', resumeContractCheckout);

module.exports = router;

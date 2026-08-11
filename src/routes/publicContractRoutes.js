const express = require('express');
const { getPublicContractByToken, signPublicContract, downloadPublicContractPdf } = require('../controllers/contractController');

const router = express.Router();

router.get('/:token', getPublicContractByToken);
router.get('/:token/pdf', downloadPublicContractPdf);
router.post('/:token/sign', signPublicContract);

module.exports = router;

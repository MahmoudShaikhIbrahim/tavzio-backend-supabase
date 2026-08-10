const express = require('express');
const { getPublicContractByToken, signPublicContract } = require('../controllers/contractController');

const router = express.Router();

router.get('/:token', getPublicContractByToken);
router.post('/:token/sign', signPublicContract);

module.exports = router;

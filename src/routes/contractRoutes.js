const express = require('express');
const { createContract, sendContract, listContracts, previewContract, signContract, downloadContractPdf } = require('../controllers/contractController');
const { generateContractReceipt } = require('../controllers/receiptController');
const { protect, authorize, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.post('/', authorize('super_admin'), createContract);
router.post('/:contractId/send', authorize('super_admin'), sendContract);
router.get('/', listContracts); // owner/staff read own, super_admin reads any (RLS-backed)
router.get('/:contractId/preview', previewContract);
router.get('/:contractId/pdf', downloadContractPdf);
router.post('/:contractId/sign', authorize('business_owner'), signContract);
router.post('/:contractId/receipts/next', authorize('super_admin'), generateContractReceipt);

module.exports = router;

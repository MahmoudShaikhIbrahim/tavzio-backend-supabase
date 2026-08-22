const express = require('express');
const {
  createStandaloneContract, listAllContracts, sendContract, previewStandaloneContract, onboardContract,
  terminateContract, deleteContract,
} = require('../controllers/contractController');
const { protect, authorize } = require('../middleware/auth');

// Mounted at /api/contracts - deliberately NOT nested under
// /api/businesses/:businessId, since a contract here doesn't belong to a
// business yet. Everything is super_admin only: this is the "Create
// Contract" -> send -> (client signs+pays) -> "Onboard" pipeline.
const router = express.Router();

router.use(protect, authorize('super_admin'));

router.post('/', createStandaloneContract);
router.get('/', listAllContracts);
router.get('/:contractId/preview', previewStandaloneContract);
router.post('/:contractId/send', sendContract);
router.post('/:contractId/onboard', onboardContract);
// Terminate (signed+ contracts, preserves the record, triggers real
// account consequences) vs delete (draft/sent only, hard removal) -
// see contractController.js for why these are two genuinely different
// operations, not one action with a flag.
router.post('/:contractId/terminate', terminateContract);
router.delete('/:contractId', deleteContract);

module.exports = router;

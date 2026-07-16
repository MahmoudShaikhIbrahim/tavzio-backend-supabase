const express = require('express');
const {
  getProgram,
  upsertProgram,
  listMembers,
  adjustMember,
  redeemReward,
} = require('../controllers/loyaltyController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/program', getProgram);
router.put('/program', upsertProgram);
router.get('/members', listMembers);
router.post('/members/:membershipId/adjust', adjustMember);
router.post('/members/:membershipId/redeem', redeemReward);

module.exports = router;

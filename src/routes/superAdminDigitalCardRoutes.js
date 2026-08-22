const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const {
  listSuperAdminCards, createSuperAdminCard, updateSuperAdminCard, deleteSuperAdminCard, getSuperAdminCardAnalytics,
} = require('../controllers/digitalCardController');

// The multi-card capability lives only here, behind authorize('super_admin')
// on every route - a business_owner or staff token is rejected before it
// ever reaches the controller. The controller then additionally scopes
// every query to owner_user_id = req.user.id, so this is enforced twice,
// not just once.
const router = express.Router();

router.use(protect, authorize('super_admin'));

router.get('/', listSuperAdminCards);
router.post('/', createSuperAdminCard);
router.patch('/:cardId', updateSuperAdminCard);
router.delete('/:cardId', deleteSuperAdminCard);
router.get('/:cardId/analytics', getSuperAdminCardAnalytics);

module.exports = router;

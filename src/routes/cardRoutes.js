const express = require('express');
const { createCards, listCards, updateCard, deleteCard } = require('../controllers/cardController');
const { protect, authorize, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

// Only super_admin creates cards - prevents an accidental extra card from
// owner/staff; they can still rename and change status of existing ones.
router.post('/', authorize('super_admin'), createCards);
router.get('/', listCards);
router.patch('/:cardId', updateCard);

// Delete restored, but super_admin only - owner/staff still have no
// delete capability at all, "Disable" remains their only retirement
// path. RLS backs this up independently (see migration 0010).
router.delete('/:cardId', authorize('super_admin'), deleteCard);

module.exports = router;

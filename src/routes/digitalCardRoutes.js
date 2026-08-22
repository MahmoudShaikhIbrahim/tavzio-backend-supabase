const express = require('express');
const { protect, enforceTenant } = require('../middleware/auth');
const {
  getBusinessCard, createBusinessCard, updateBusinessCard, getBusinessCardAnalytics,
} = require('../controllers/digitalCardController');

// Mounted at /api/businesses/:businessId/digital-card. Reads via
// req.supabase (RLS-scoped) so "one card per business" and "staff can
// view but not edit" are real database rules, not just what this route
// file happens to allow - see the RLS policies in the migration.
const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/', getBusinessCard);
router.post('/', createBusinessCard);
router.patch('/:cardId', updateBusinessCard);
router.get('/:cardId/analytics', getBusinessCardAnalytics);

module.exports = router;

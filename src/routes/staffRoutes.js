const express = require('express');
const { inviteStaff, listStaff, setStaffActive, setStaffJobRole, listRolePermissions } = require('../controllers/staffController');
const { issueAdminCard } = require('../controllers/cardController');
const { protect, authorize, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

// Only the owner (or super_admin) manages staff and admin cards — a staff
// member can't invite other staff or issue cards, including their own.
router.post('/', authorize('business_owner', 'super_admin'), inviteStaff);
router.get('/', listStaff);
router.patch('/:userId', authorize('business_owner', 'super_admin'), setStaffActive);
router.patch('/:userId/job-role', authorize('business_owner', 'super_admin'), setStaffJobRole);
router.get('/role-permissions', listRolePermissions);
// Only you issue/reissue admin cards — matches how the physical NFC chips
// actually get programmed (in person, by the platform operator). Either the
// owner or a staff member can DISABLE any card the moment they notice one's
// lost — that's the existing generic PATCH /cards/:cardId route, open to
// any authenticated member of the business already. Getting a replacement
// card working again is a "contact me" step, on purpose.
router.post('/:userId/card', authorize('super_admin'), issueAdminCard);

module.exports = router;

const express = require('express');
const { inviteStaff, resendStaffInvite, listStaff, setStaffActive, deleteStaff, setStaffJobRole, setStaffSections, setStaffOutlets, setStaffFullAccess, setMyNavLayout, setStaffAvatar, setStaffPhone, listRolePermissions, resetPassword } = require('../controllers/staffController');
const { clearStaffPin } = require('../controllers/pinController');
const { issueAdminCard } = require('../controllers/cardController');
const { protect, authorize, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

// Only the owner (or super_admin) manages staff and admin cards — a staff
// member can't invite other staff or issue cards, including their own.
router.post('/', authorize('business_owner', 'super_admin'), inviteStaff);
router.get('/', listStaff);
router.patch('/:userId', authorize('business_owner', 'super_admin'), setStaffActive);
// Permanent removal - separate from the PATCH above, which only
// deactivates (blocks login, keeps history). This deletes the account
// outright; see deleteStaff for exactly what that cascades to.
router.delete('/:userId', authorize('business_owner', 'super_admin'), deleteStaff);
router.patch('/:userId/job-role', authorize('business_owner', 'super_admin'), setStaffJobRole);
// Which dashboard sections this staff account is allowed to see - the
// same "owner/super_admin manage, staff never touch their own" pattern
// as everything else in this file.
router.patch('/:userId/sections', authorize('business_owner', 'super_admin'), setStaffSections);
router.patch('/:userId/outlets', authorize('business_owner', 'super_admin'), setStaffOutlets);
// Owner-equivalent access for one specific staff account - see the
// 0083 migration and authorize()/current_role_name() for what this
// actually unlocks (every owner-only route and RLS policy in the app).
// Same "owner or super_admin manage, staff never touch their own"
// pattern as everything else here - a delegate can't grant this
// onward to someone else.
router.patch('/:userId/full-access', authorize('business_owner', 'super_admin'), setStaffFullAccess);
// The one exception to that pattern: nav layout (hide/reorder tabs) is
// a personal display preference, not an access grant, so it's
// deliberately self-service - setMyNavLayout itself enforces that
// :userId can only ever be the caller's own id, not gated by role here.
router.patch('/:userId/nav-layout', setMyNavLayout);
// Explicit request: an owner/manager sets a team member's photo and
// phone for them - never self-service, unlike nav-layout above.
router.patch('/:userId/avatar', authorize('business_owner', 'super_admin'), setStaffAvatar);
router.patch('/:userId/phone', authorize('business_owner', 'super_admin'), setStaffPhone);
// The actual fix for "an onboarded account is locked out and nobody can
// get back in" - generates a real temporary password directly via the
// Supabase Admin API, forces a fresh one on next login. Owner or
// super_admin can trigger this for any account in the business
// (including the owner's own, if truly locked out and unable to reach
// the normal Change Password flow in Settings).
router.post('/:userId/reset-password', authorize('business_owner', 'super_admin'), resetPassword);
// Same "owner unlocks a locked-out staff member" pattern as reset-password
// above - clears (never sets a known replacement) a forgotten POS PIN.
router.delete('/:userId/pin', authorize('business_owner', 'super_admin'), clearStaffPin);
router.post('/:userId/resend-invite', authorize('business_owner', 'super_admin'), resendStaffInvite);
router.get('/role-permissions', listRolePermissions);
// Only you issue/reissue admin cards — matches how the physical NFC chips
// actually get programmed (in person, by the platform operator). Either the
// owner or a staff member can DISABLE any card the moment they notice one's
// lost — that's the existing generic PATCH /cards/:cardId route, open to
// any authenticated member of the business already. Getting a replacement
// card working again is a "contact me" step, on purpose.
router.post('/:userId/card', authorize('super_admin'), issueAdminCard);

module.exports = router;

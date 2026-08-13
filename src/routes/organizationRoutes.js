const express = require('express');
const {
  listOrganizations, createOrganization, setBusinessOrganization, inviteOrgOwner,
  requireOrgOwner, getMyOrganization,
  listOrgMenuCategories, createOrgMenuCategory, createOrgMenuItem, updateOrgMenuItem, deleteOrgMenuItem,
  publishMenuToLocations, getConsolidatedReport,
} = require('../controllers/organizationController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

// Super admin: create orgs, link/unlink locations, invite org owners
router.get('/', authorize('super_admin'), listOrganizations);
router.post('/', authorize('super_admin'), createOrganization);
router.patch('/businesses/:businessId/organization', authorize('super_admin'), setBusinessOrganization);
router.post('/:organizationId/owner', authorize('super_admin'), inviteOrgOwner);

// org_owner (or super_admin acting on behalf of one, via ?organizationId=)
router.get('/mine', authorize('org_owner', 'super_admin'), requireOrgOwner, getMyOrganization);
router.get('/menu/categories', authorize('org_owner', 'super_admin'), requireOrgOwner, listOrgMenuCategories);
router.post('/menu/categories', authorize('org_owner', 'super_admin'), requireOrgOwner, createOrgMenuCategory);
router.post('/menu/items', authorize('org_owner', 'super_admin'), requireOrgOwner, createOrgMenuItem);
router.patch('/menu/items/:itemId', authorize('org_owner', 'super_admin'), requireOrgOwner, updateOrgMenuItem);
router.delete('/menu/items/:itemId', authorize('org_owner', 'super_admin'), requireOrgOwner, deleteOrgMenuItem);
router.post('/menu/publish', authorize('org_owner', 'super_admin'), requireOrgOwner, publishMenuToLocations);
router.get('/report', authorize('org_owner', 'super_admin'), requireOrgOwner, getConsolidatedReport);

module.exports = router;

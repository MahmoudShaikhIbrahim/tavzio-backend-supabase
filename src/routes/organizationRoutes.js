const express = require('express');
const {
  listOrganizations, createOrganization, deleteOrganization, setBusinessOrganization, inviteOrgOwner,
  requireOrgOwner, getMyOrganization,
  listOrgMenuCategories, createOrgMenuCategory, createOrgMenuItem, updateOrgMenuItem, deleteOrgMenuItem,
  publishMenuToLocations, getConsolidatedReport, getHotelConsolidatedReport,
  listOrgSuppliers, createOrgSupplier, updateOrgSupplier, deleteOrgSupplier,
  listOrgPurchaseOrders, createOrgPurchaseOrder,
} = require('../controllers/organizationController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

// Super admin: create orgs, link/unlink locations, invite org owners
router.get('/', authorize('super_admin'), listOrganizations);
router.post('/', authorize('super_admin'), createOrganization);
router.delete('/:organizationId', authorize('super_admin'), deleteOrganization);
router.patch('/businesses/:businessId/organization', authorize('super_admin'), setBusinessOrganization);
router.post('/:organizationId/owner', authorize('super_admin'), inviteOrgOwner);

// org_owner (or super_admin acting on behalf of one, via ?organizationId=)
// authorize('org_owner', ...) removed here - requireOrgOwner below does
// the complete, correct check on its own (standalone org_owner role,
// self-service is_org_owner capability, and the super_admin special
// case), and running authorize('org_owner', 'super_admin') first would
// reject a self-service org owner (role stays business_owner or staff -
// see migration 0098) before requireOrgOwner ever got a chance to say
// yes.
router.get('/mine', requireOrgOwner, getMyOrganization);
router.get('/menu/categories', requireOrgOwner, listOrgMenuCategories);
router.post('/menu/categories', requireOrgOwner, createOrgMenuCategory);
router.post('/menu/items', requireOrgOwner, createOrgMenuItem);
router.patch('/menu/items/:itemId', requireOrgOwner, updateOrgMenuItem);
router.delete('/menu/items/:itemId', requireOrgOwner, deleteOrgMenuItem);
router.post('/menu/publish', requireOrgOwner, publishMenuToLocations);
router.get('/report', requireOrgOwner, getConsolidatedReport);
router.get('/report/hotel', requireOrgOwner, getHotelConsolidatedReport);

// Supply chain: shared suppliers, POs split across member businesses
router.get('/suppliers', requireOrgOwner, listOrgSuppliers);
router.post('/suppliers', requireOrgOwner, createOrgSupplier);
router.patch('/suppliers/:supplierId', requireOrgOwner, updateOrgSupplier);
router.delete('/suppliers/:supplierId', requireOrgOwner, deleteOrgSupplier);
router.get('/purchase-orders', requireOrgOwner, listOrgPurchaseOrders);
router.post('/purchase-orders', requireOrgOwner, createOrgPurchaseOrder);

module.exports = router;

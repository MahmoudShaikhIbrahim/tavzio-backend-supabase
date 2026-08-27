const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const {
  listDemoMenuItems, createDemoMenuItem, updateDemoMenuItem, deleteDemoMenuItem, importFromBusiness,
  getDemoSettingsAdmin, updateDemoSettings,
} = require('../controllers/demoAdminController');

// Demo Settings is a super_admin-only concept - it's Tavzio's own
// marketing tool, not something any individual business account should
// see or touch, same reasoning as superAdminDigitalCardRoutes.
const router = express.Router();

router.use(protect, authorize('super_admin'));

router.get('/menu-items', listDemoMenuItems);
router.post('/menu-items', createDemoMenuItem);
router.patch('/menu-items/:itemId', updateDemoMenuItem);
router.delete('/menu-items/:itemId', deleteDemoMenuItem);
router.post('/menu-items/import', importFromBusiness);
router.get('/settings', getDemoSettingsAdmin);
router.patch('/settings', updateDemoSettings);

module.exports = router;

const express = require('express');
const {
  listCategories, createCategory, updateCategory, deleteCategory,
  listItems, createItem, updateItem, deleteItem,
  listAddons, createAddon, updateAddon, deleteAddon,
} = require('../controllers/menuController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/categories', listCategories);
router.post('/categories', createCategory);
router.patch('/categories/:categoryId', updateCategory);
router.delete('/categories/:categoryId', deleteCategory);

router.get('/items', listItems);
router.post('/items', createItem);
router.patch('/items/:itemId', updateItem);
router.delete('/items/:itemId', deleteItem);

router.get('/items/:itemId/addons', listAddons);
router.post('/items/:itemId/addons', createAddon);
router.patch('/items/:itemId/addons/:addonId', updateAddon);
router.delete('/items/:itemId/addons/:addonId', deleteAddon);

module.exports = router;

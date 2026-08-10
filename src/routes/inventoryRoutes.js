const express = require('express');
const {
  listSuppliers, createSupplier,
  listIngredients, createIngredient, updateIngredient, adjustStock,
  getRecipe, setRecipe,
  listPurchaseOrders, createPurchaseOrder, receivePurchaseOrder,
} = require('../controllers/inventoryController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/suppliers', listSuppliers);
router.post('/suppliers', createSupplier);

router.get('/ingredients', listIngredients);
router.post('/ingredients', createIngredient);
router.patch('/ingredients/:ingredientId', updateIngredient);
router.post('/ingredients/:ingredientId/adjust', adjustStock);

router.get('/menu-items/:menuItemId/recipe', getRecipe);
router.put('/menu-items/:menuItemId/recipe', setRecipe);

router.get('/purchase-orders', listPurchaseOrders);
router.post('/purchase-orders', createPurchaseOrder);
router.post('/purchase-orders/:poId/receive', receivePurchaseOrder);

module.exports = router;

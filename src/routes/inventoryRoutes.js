const express = require('express');
const {
  listSuppliers, createSupplier, updateSupplier, deleteSupplier,
  listIngredients, createIngredient, updateIngredient, deleteIngredient, adjustStock,
  recordWaste, getWasteReport, getLowStock, getValuation,
  getMenuItemFoodCost, getActualFoodCost,
  getRecipe, setRecipe,
  listPurchaseOrders, createPurchaseOrder, receivePurchaseOrder,
} = require('../controllers/inventoryController');
const { protect, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

router.use(protect, enforceTenant);

router.get('/suppliers', listSuppliers);
router.post('/suppliers', createSupplier);
router.patch('/suppliers/:supplierId', updateSupplier);
router.delete('/suppliers/:supplierId', deleteSupplier);

router.get('/ingredients', listIngredients);
router.post('/ingredients', createIngredient);
router.patch('/ingredients/:ingredientId', updateIngredient);
router.delete('/ingredients/:ingredientId', deleteIngredient);
router.post('/ingredients/:ingredientId/adjust', adjustStock);
router.post('/ingredients/:ingredientId/waste', recordWaste);

router.get('/low-stock', getLowStock);
router.get('/valuation', getValuation);
router.get('/waste-report', getWasteReport);
router.get('/food-cost', getMenuItemFoodCost);
router.get('/food-cost/actual', getActualFoodCost);

router.get('/menu-items/:menuItemId/recipe', getRecipe);
router.put('/menu-items/:menuItemId/recipe', setRecipe);

router.get('/purchase-orders', listPurchaseOrders);
router.post('/purchase-orders', createPurchaseOrder);
router.post('/purchase-orders/:poId/receive', receivePurchaseOrder);

module.exports = router;

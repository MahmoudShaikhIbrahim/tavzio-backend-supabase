const express = require('express');
const { getSalesForecast, getBudget, setBudget, getBudgetVsActual } = require('../controllers/forecastingController');
const { protect, enforceTenant, authorize } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

// Owner/super_admin only - budgeting and revenue forecasting are
// business-planning data, same sensitivity class as HR and analytics.
router.use(protect, enforceTenant, authorize('business_owner', 'super_admin'));

router.get('/sales-forecast', getSalesForecast);
router.get('/budget', getBudget);
router.put('/budget', setBudget);
router.get('/budget-vs-actual', getBudgetVsActual);

module.exports = router;

const express = require('express');
const {
  listStaffDocuments, uploadStaffDocument, deleteStaffDocument,
  setStaffCommission, getCommissionReport,
  listTipDistributions, createTipDistribution,
} = require('../controllers/hrController');
const { protect, authorize, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

// Owner/super_admin only - no staff exception, ever. This is the actual
// enforcement point (on top of the requireHrFeature checks inside the
// controller and RLS on the tables themselves) that keeps HR out of
// reach for any staff account, regardless of what sections it's assigned.
router.use(protect, enforceTenant, authorize('business_owner', 'super_admin'));

router.get('/documents', listStaffDocuments);
router.post('/documents', uploadStaffDocument);
router.delete('/documents/:documentId', deleteStaffDocument);

router.patch('/commission/:staffId', setStaffCommission);
router.get('/commission-report', getCommissionReport);

router.get('/tip-distributions', listTipDistributions);
router.post('/tip-distributions', createTipDistribution);

module.exports = router;

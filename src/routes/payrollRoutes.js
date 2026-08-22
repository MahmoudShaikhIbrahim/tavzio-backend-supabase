const express = require('express');
const {
  listSalaryStructures, setSalaryStructure,
  listPayrollRuns, createPayrollRun, listPayslipsForRun, setPayslipDeductions,
  approvePayrollRun, markPayrollRunPaid, recordWpsExport,
} = require('../controllers/payrollController');
const { protect, authorize, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

// Any authenticated staff member can see their OWN payslips - registered
// before the owner-only gate below, and backed independently by the
// "staff view own payslips" RLS policy on the payslips table itself
// (payslips.staff_id = auth.uid()), so this stays safe even if the
// route-level check here were ever removed.
router.get('/my-payslips', protect, enforceTenant, require('../controllers/payrollController').listMyPayslips);

// Owner/super_admin only - payroll is financial data, same access level
// as HR, never opened to staff regardless of assigned sections.
router.use(protect, enforceTenant, authorize('business_owner', 'super_admin'));

router.get('/salary-structures', listSalaryStructures);
router.post('/salary-structures', setSalaryStructure);

router.get('/runs', listPayrollRuns);
router.post('/runs', createPayrollRun);
router.get('/runs/:runId/payslips', listPayslipsForRun);
router.patch('/runs/:runId/deductions/:payslipId', setPayslipDeductions);
router.patch('/runs/:runId/approve', approvePayrollRun);
router.patch('/runs/:runId/mark-paid', markPayrollRunPaid);
router.post('/runs/:runId/wps-export', recordWpsExport);

module.exports = router;

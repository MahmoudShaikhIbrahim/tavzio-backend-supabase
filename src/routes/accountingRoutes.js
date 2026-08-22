const express = require('express');
const {
  listAccounts, createAccount, seedDefaultAccounts,
  listJournalEntries, createJournalEntry, postJournalEntry, voidJournalEntry, getTrialBalance,
  listVendors, createVendor, listApBills, createApBill, recordApPayment,
  listArInvoices, createArInvoice, recordArReceipt,
} = require('../controllers/accountingController');
const { protect, authorize, enforceTenant } = require('../middleware/auth');

const router = express.Router({ mergeParams: true });

// Owner/super_admin only - accounting is financial data, same standard
// as payroll and HR.
router.use(protect, enforceTenant, authorize('business_owner', 'super_admin'));

router.get('/accounts', listAccounts);
router.post('/accounts', createAccount);
router.post('/accounts/seed-defaults', seedDefaultAccounts);

router.get('/journal-entries', listJournalEntries);
router.post('/journal-entries', createJournalEntry);
router.patch('/journal-entries/:entryId/post', postJournalEntry);
router.patch('/journal-entries/:entryId/void', voidJournalEntry);

router.get('/trial-balance', getTrialBalance);

router.get('/vendors', listVendors);
router.post('/vendors', createVendor);
router.get('/ap-bills', listApBills);
router.post('/ap-bills', createApBill);
router.patch('/ap-bills/:billId/pay', recordApPayment);

router.get('/ar-invoices', listArInvoices);
router.post('/ar-invoices', createArInvoice);
router.patch('/ar-invoices/:invoiceId/receive', recordArReceipt);

module.exports = router;

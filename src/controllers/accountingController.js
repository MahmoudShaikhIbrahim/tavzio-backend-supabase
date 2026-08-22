const asyncHandler = require('../utils/asyncHandler');

async function requireAccountingFeature(req, res) {
  const { data: business } = await req.supabase.from('businesses').select('features').eq('id', req.params.businessId).single();
  if (!business?.features?.accounting?.enabled) {
    res.status(403).json({ message: 'Accounting is not enabled for this business - turn it on in Features first.' });
    return null;
  }
  return business;
}

// --- Chart of accounts ---

const listAccounts = asyncHandler(async (req, res) => {
  if (!(await requireAccountingFeature(req, res))) return;
  const { data, error } = await req.supabase
    .from('chart_of_accounts')
    .select('*')
    .eq('business_id', req.params.businessId)
    .order('code');
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/accounting/accounts
// Body: { code, name, accountType, parentAccountId }
const createAccount = asyncHandler(async (req, res) => {
  if (!(await requireAccountingFeature(req, res))) return;
  const { code, name, accountType, parentAccountId = null } = req.body;
  if (!code || !name || !accountType) return res.status(400).json({ message: 'code, name, and accountType are required' });
  if (!['asset', 'liability', 'equity', 'revenue', 'expense'].includes(accountType)) {
    return res.status(400).json({ message: 'accountType must be asset, liability, equity, revenue, or expense' });
  }
  const { data, error } = await req.supabase
    .from('chart_of_accounts')
    .insert({ business_id: req.params.businessId, code, name, account_type: accountType, parent_account_id: parentAccountId })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// @route POST /api/businesses/:businessId/accounting/accounts/seed-defaults
// One-click starter chart of accounts, so a business doesn't have to
// build every line manually before they can post a single entry - the
// same "sensible default, fully editable after" pattern already used
// for hotel_pricing_rules seeding.
const DEFAULT_ACCOUNTS = [
  { code: '1000', name: 'Cash', accountType: 'asset' },
  { code: '1010', name: 'Bank', accountType: 'asset' },
  { code: '1200', name: 'Accounts Receivable', accountType: 'asset' },
  { code: '1400', name: 'Inventory', accountType: 'asset' },
  { code: '2000', name: 'Accounts Payable', accountType: 'liability' },
  { code: '2100', name: 'VAT Payable', accountType: 'liability' },
  { code: '2200', name: 'Payroll Payable', accountType: 'liability' },
  { code: '3000', name: 'Owner Equity', accountType: 'equity' },
  { code: '4000', name: 'Room Revenue', accountType: 'revenue' },
  { code: '4100', name: 'F&B Revenue', accountType: 'revenue' },
  { code: '4200', name: 'Other Revenue', accountType: 'revenue' },
  { code: '5000', name: 'Cost of Goods Sold', accountType: 'expense' },
  { code: '5100', name: 'Payroll Expense', accountType: 'expense' },
  { code: '5200', name: 'Utilities Expense', accountType: 'expense' },
  { code: '5300', name: 'Maintenance Expense', accountType: 'expense' },
  { code: '5900', name: 'General & Administrative', accountType: 'expense' },
];
const seedDefaultAccounts = asyncHandler(async (req, res) => {
  if (!(await requireAccountingFeature(req, res))) return;
  const rows = DEFAULT_ACCOUNTS.map((a) => ({ business_id: req.params.businessId, code: a.code, name: a.name, account_type: a.accountType }));
  const { data, error } = await req.supabase.from('chart_of_accounts').upsert(rows, { onConflict: 'business_id,code', ignoreDuplicates: true }).select();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// --- Journal entries ---

const listJournalEntries = asyncHandler(async (req, res) => {
  if (!(await requireAccountingFeature(req, res))) return;
  const { from, to } = req.query;
  let query = req.supabase
    .from('journal_entries')
    .select('*, journal_entry_lines(*, chart_of_accounts(code, name))')
    .eq('business_id', req.params.businessId)
    .order('entry_date', { ascending: false });
  if (from) query = query.gte('entry_date', from);
  if (to) query = query.lte('entry_date', to);
  const { data, error } = await query;
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/accounting/journal-entries
// Body: { entryDate, reference, description, lines: [{ accountId, debitAed, creditAed, memo }] }
// Created as draft always - lines can only be added at creation time
// (no separate line-editing endpoint) to keep the balance check simple
// and avoid a half-edited entry sitting in an ambiguous state.
const createJournalEntry = asyncHandler(async (req, res) => {
  if (!(await requireAccountingFeature(req, res))) return;
  const { entryDate, reference = '', description = '', lines } = req.body;
  if (!Array.isArray(lines) || lines.length < 2) {
    return res.status(400).json({ message: 'At least two lines are required for a double-entry journal entry' });
  }
  for (const l of lines) {
    if (!l.accountId) return res.status(400).json({ message: 'Every line requires an accountId' });
    if ((Number(l.debitAed) || 0) > 0 && (Number(l.creditAed) || 0) > 0) {
      return res.status(400).json({ message: 'A line cannot have both a debit and a credit' });
    }
  }
  const totalDebits = lines.reduce((sum, l) => sum + (Number(l.debitAed) || 0), 0);
  const totalCredits = lines.reduce((sum, l) => sum + (Number(l.creditAed) || 0), 0);
  if (Math.round(totalDebits * 100) !== Math.round(totalCredits * 100)) {
    return res.status(400).json({ message: `Entry is not balanced: debits ${totalDebits} vs credits ${totalCredits}` });
  }

  const { data: entry, error: entryError } = await req.supabase
    .from('journal_entries')
    .insert({ business_id: req.params.businessId, entry_date: entryDate || new Date().toISOString().slice(0, 10), reference, description, source_type: 'manual' })
    .select()
    .single();
  if (entryError) return res.status(400).json({ message: entryError.message });

  const lineRows = lines.map((l) => ({
    journal_entry_id: entry.id,
    account_id: l.accountId,
    debit_aed: Number(l.debitAed) || 0,
    credit_aed: Number(l.creditAed) || 0,
    memo: l.memo || '',
  }));
  const { error: linesError } = await req.supabase.from('journal_entry_lines').insert(lineRows);
  if (linesError) return res.status(400).json({ message: linesError.message });

  res.status(201).json({ ...entry, lines: lineRows });
});

// @route PATCH /api/businesses/:businessId/accounting/journal-entries/:entryId/post
// The balance re-check trigger on journal_entries (trg_journal_entry_balanced,
// see migration 0077) is the real enforcement here - this endpoint just
// flips status and lets the database refuse an unbalanced post outright.
const postJournalEntry = asyncHandler(async (req, res) => {
  if (!(await requireAccountingFeature(req, res))) return;
  const { data, error } = await req.supabase
    .from('journal_entries')
    .update({ status: 'posted', posted_by: req.user.id })
    .eq('id', req.params.entryId)
    .eq('business_id', req.params.businessId)
    .eq('status', 'draft')
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message.includes('not balanced') ? error.message : 'Could not post entry - it may already be posted or not exist.' });
  res.json(data);
});

const voidJournalEntry = asyncHandler(async (req, res) => {
  if (!(await requireAccountingFeature(req, res))) return;
  const { data, error } = await req.supabase
    .from('journal_entries')
    .update({ status: 'voided' })
    .eq('id', req.params.entryId)
    .eq('business_id', req.params.businessId)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ message: 'Journal entry not found' });
  res.json(data);
});

// @route GET /api/businesses/:businessId/accounting/trial-balance?asOf=
// Standard trial balance: every account's net debit/credit position
// from posted entries only, as of a given date.
const getTrialBalance = asyncHandler(async (req, res) => {
  if (!(await requireAccountingFeature(req, res))) return;
  const asOf = req.query.asOf || new Date().toISOString().slice(0, 10);

  const { data: entries } = await req.supabase
    .from('journal_entries')
    .select('id, journal_entry_lines(account_id, debit_aed, credit_aed, chart_of_accounts(code, name, account_type))')
    .eq('business_id', req.params.businessId)
    .eq('status', 'posted')
    .lte('entry_date', asOf);

  const byAccount = new Map();
  for (const e of entries || []) {
    for (const l of e.journal_entry_lines || []) {
      const key = l.account_id;
      const entry = byAccount.get(key) || { accountId: key, code: l.chart_of_accounts?.code, name: l.chart_of_accounts?.name, accountType: l.chart_of_accounts?.account_type, debitAed: 0, creditAed: 0 };
      entry.debitAed += Number(l.debit_aed);
      entry.creditAed += Number(l.credit_aed);
      byAccount.set(key, entry);
    }
  }

  const rows = Array.from(byAccount.values())
    .map((r) => ({ ...r, debitAed: Math.round(r.debitAed * 100) / 100, creditAed: Math.round(r.creditAed * 100) / 100 }))
    .sort((a, b) => (a.code || '').localeCompare(b.code || ''));

  res.json({
    asOf,
    rows,
    totalDebits: Math.round(rows.reduce((sum, r) => sum + r.debitAed, 0) * 100) / 100,
    totalCredits: Math.round(rows.reduce((sum, r) => sum + r.creditAed, 0) * 100) / 100,
  });
});

// --- Accounts Payable ---

const listVendors = asyncHandler(async (req, res) => {
  if (!(await requireAccountingFeature(req, res))) return;
  const { data, error } = await req.supabase.from('vendors').select('*').eq('business_id', req.params.businessId).order('name');
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

const createVendor = asyncHandler(async (req, res) => {
  if (!(await requireAccountingFeature(req, res))) return;
  const { name, contactEmail = '', contactPhone = '', paymentTermsDays = 30 } = req.body;
  if (!name) return res.status(400).json({ message: 'name is required' });
  const { data, error } = await req.supabase
    .from('vendors')
    .insert({ business_id: req.params.businessId, name, contact_email: contactEmail, contact_phone: contactPhone, payment_terms_days: paymentTermsDays })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

const listApBills = asyncHandler(async (req, res) => {
  if (!(await requireAccountingFeature(req, res))) return;
  const { data, error } = await req.supabase
    .from('ap_bills')
    .select('*, vendors(name)')
    .eq('business_id', req.params.businessId)
    .order('due_date');
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/accounting/ap-bills
// Body: { vendorId, purchaseOrderId, billNumber, billDate, dueDate, amountAed }
const createApBill = asyncHandler(async (req, res) => {
  if (!(await requireAccountingFeature(req, res))) return;
  const { vendorId, purchaseOrderId = null, billNumber = '', billDate, dueDate, amountAed } = req.body;
  if (!vendorId || !dueDate || amountAed == null) return res.status(400).json({ message: 'vendorId, dueDate, and amountAed are required' });
  const { data, error } = await req.supabase
    .from('ap_bills')
    .insert({
      business_id: req.params.businessId, vendor_id: vendorId, purchase_order_id: purchaseOrderId,
      bill_number: billNumber, bill_date: billDate || new Date().toISOString().slice(0, 10), due_date: dueDate, amount_aed: Number(amountAed),
    })
    .select('*, vendors(name)')
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// @route PATCH /api/businesses/:businessId/accounting/ap-bills/:billId/pay
// Body: { amountPaidAed }
const recordApPayment = asyncHandler(async (req, res) => {
  if (!(await requireAccountingFeature(req, res))) return;
  const { amountPaidAed } = req.body;
  if (amountPaidAed == null) return res.status(400).json({ message: 'amountPaidAed is required' });
  const { data: bill } = await req.supabase.from('ap_bills').select('amount_aed, amount_paid_aed').eq('id', req.params.billId).eq('business_id', req.params.businessId).single();
  if (!bill) return res.status(404).json({ message: 'Bill not found' });
  const newPaid = Math.round((Number(bill.amount_paid_aed) + Number(amountPaidAed)) * 100) / 100;
  const status = newPaid >= Number(bill.amount_aed) ? 'paid' : 'partial';
  const { data, error } = await req.supabase
    .from('ap_bills')
    .update({ amount_paid_aed: newPaid, status })
    .eq('id', req.params.billId)
    .select('*, vendors(name)')
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// --- Accounts Receivable ---

const listArInvoices = asyncHandler(async (req, res) => {
  if (!(await requireAccountingFeature(req, res))) return;
  const { data, error } = await req.supabase.from('ar_invoices').select('*').eq('business_id', req.params.businessId).order('due_date');
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/accounting/ar-invoices
// Body: { customerName, customerEmail, invoiceNumber, invoiceDate, dueDate, amountAed }
const createArInvoice = asyncHandler(async (req, res) => {
  if (!(await requireAccountingFeature(req, res))) return;
  const { customerName, customerEmail = '', invoiceNumber = '', invoiceDate, dueDate, amountAed } = req.body;
  if (!customerName || !dueDate || amountAed == null) return res.status(400).json({ message: 'customerName, dueDate, and amountAed are required' });
  const { data, error } = await req.supabase
    .from('ar_invoices')
    .insert({
      business_id: req.params.businessId, customer_name: customerName, customer_email: customerEmail,
      invoice_number: invoiceNumber, invoice_date: invoiceDate || new Date().toISOString().slice(0, 10), due_date: dueDate, amount_aed: Number(amountAed),
    })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// @route PATCH /api/businesses/:businessId/accounting/ar-invoices/:invoiceId/receive
// Body: { amountReceivedAed }
const recordArReceipt = asyncHandler(async (req, res) => {
  if (!(await requireAccountingFeature(req, res))) return;
  const { amountReceivedAed } = req.body;
  if (amountReceivedAed == null) return res.status(400).json({ message: 'amountReceivedAed is required' });
  const { data: invoice } = await req.supabase.from('ar_invoices').select('amount_aed, amount_received_aed').eq('id', req.params.invoiceId).eq('business_id', req.params.businessId).single();
  if (!invoice) return res.status(404).json({ message: 'Invoice not found' });
  const newReceived = Math.round((Number(invoice.amount_received_aed) + Number(amountReceivedAed)) * 100) / 100;
  const status = newReceived >= Number(invoice.amount_aed) ? 'paid' : 'partial';
  const { data, error } = await req.supabase
    .from('ar_invoices')
    .update({ amount_received_aed: newReceived, status })
    .eq('id', req.params.invoiceId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

module.exports = {
  listAccounts, createAccount, seedDefaultAccounts,
  listJournalEntries, createJournalEntry, postJournalEntry, voidJournalEntry, getTrialBalance,
  listVendors, createVendor, listApBills, createApBill, recordApPayment,
  listArInvoices, createArInvoice, recordArReceipt,
};

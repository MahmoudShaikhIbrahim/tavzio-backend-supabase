const asyncHandler = require('../utils/asyncHandler');

// @route GET /api/businesses/:businessId/audit-log
const listAuditLog = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('audit_log')
    .select('*')
    .eq('business_id', req.params.businessId)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

module.exports = { listAuditLog };

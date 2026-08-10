const { supabaseAdmin } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');

// @route POST /api/public/leads
// The "Get Started" form on the marketing homepage - deliberately the
// only unauthenticated write endpoint outside the tap-gated public API,
// since this is a marketing signup, not real customer/business data.
const submitLead = asyncHandler(async (req, res) => {
  const { email, phone, businessType, standsEstimate, note = '' } = req.body;
  if (!email || !phone || !businessType) {
    return res.status(400).json({ message: 'email, phone, and businessType are required' });
  }

  const { data, error } = await supabaseAdmin
    .from('leads')
    .insert({ email, phone, business_type: businessType, stands_estimate: Number(standsEstimate) || 0, note })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  res.status(201).json({ message: "Thanks - we'll be in touch shortly.", lead: data });
});

// @route GET /api/leads  (super_admin only)
const listLeads = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase.from('leads').select('*').order('created_at', { ascending: false });
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route PATCH /api/leads/:leadId  (super_admin only)
// Marks a lead converted once its business account has been created -
// keeps the list honest about who still needs following up.
const markLeadConverted = asyncHandler(async (req, res) => {
  const { businessId } = req.body;
  const { data, error } = await req.supabase
    .from('leads')
    .update({ converted: true, converted_business_id: businessId || null })
    .eq('id', req.params.leadId)
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

module.exports = { submitLead, listLeads, markLeadConverted };

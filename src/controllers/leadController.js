const { supabaseAdmin } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');

// @route POST /api/public/leads
// Serves two different homepage forms now (see migration 0087):
// the full "Get Started" intake (business type, stand count) and the
// lightweight "Contact us for pricing" form (email, phone, preferred
// contact method only). source distinguishes which one a given lead
// came from; only get_started requires businessType.
const submitLead = asyncHandler(async (req, res) => {
  const { email, phone, businessType, standsEstimate, note = '', source = 'get_started', preferredContactMethod } = req.body;
  if (!email || !phone) {
    return res.status(400).json({ message: 'email and phone are required' });
  }
  if (source === 'get_started' && !businessType) {
    return res.status(400).json({ message: 'businessType is required' });
  }
  if (source === 'pricing_inquiry' && !['email', 'phone'].includes(preferredContactMethod)) {
    return res.status(400).json({ message: 'preferredContactMethod must be "email" or "phone"' });
  }

  const { data, error } = await supabaseAdmin
    .from('leads')
    .insert({
      email, phone, source,
      business_type: businessType || null,
      stands_estimate: Number(standsEstimate) || 0,
      preferred_contact_method: preferredContactMethod || null,
      note,
    })
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

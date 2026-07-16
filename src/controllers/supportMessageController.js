const { supabaseAdmin } = require('../config/supabaseClient');
const asyncHandler = require('../utils/asyncHandler');

// @route GET /api/businesses/:businessId/messages
const listMessages = asyncHandler(async (req, res) => {
  const { data, error } = await req.supabase
    .from('support_messages')
    .select('*')
    .eq('business_id', req.params.businessId)
    .order('created_at', { ascending: true });

  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/businesses/:businessId/messages
// Body: { message }
const sendMessage = asyncHandler(async (req, res) => {
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ message: 'Message cannot be empty' });

  const senderRole = req.user.role === 'super_admin' ? 'super_admin' : 'business';

  const { data, error } = await req.supabase
    .from('support_messages')
    .insert({
      business_id: req.params.businessId,
      sender_role: senderRole,
      sender_id: req.user.id,
      message: message.trim(),
      // Whoever sends it has obviously "read" their own message; the
      // other side hasn't seen it yet, which is exactly what drives the
      // unread badge.
      read_by_business: senderRole === 'business',
      read_by_super_admin: senderRole === 'super_admin',
    })
    .select()
    .single();

  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// @route PATCH /api/businesses/:businessId/messages/read
// Marks every message in this thread as read by whichever side is
// currently viewing it.
const markMessagesRead = asyncHandler(async (req, res) => {
  const field = req.user.role === 'super_admin' ? 'read_by_super_admin' : 'read_by_business';

  const { error } = await req.supabase
    .from('support_messages')
    .update({ [field]: true })
    .eq('business_id', req.params.businessId);

  if (error) return res.status(400).json({ message: error.message });
  res.json({ message: 'Marked as read' });
});

// @route GET /api/messages/inbox  (super_admin only, not business-scoped)
// One row per business that has ever messaged, most recently active
// first, with an unread count - the actual inbox view.
const getInbox = asyncHandler(async (req, res) => {
  const { data: messages } = await supabaseAdmin
    .from('support_messages')
    .select('business_id, message, sender_role, read_by_super_admin, created_at, businesses(name, slug)')
    .order('created_at', { ascending: false });

  const byBusiness = {};
  for (const m of messages || []) {
    if (!byBusiness[m.business_id]) {
      byBusiness[m.business_id] = {
        businessId: m.business_id,
        businessName: m.businesses?.name || 'Unknown',
        businessSlug: m.businesses?.slug || '',
        lastMessage: m.message,
        lastMessageAt: m.created_at,
        unreadCount: 0,
      };
    }
    if (m.sender_role === 'business' && !m.read_by_super_admin) {
      byBusiness[m.business_id].unreadCount += 1;
    }
  }

  res.json(Object.values(byBusiness));
});

module.exports = { listMessages, sendMessage, markMessagesRead, getInbox };

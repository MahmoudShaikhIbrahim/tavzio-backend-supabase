const { supabaseAdmin } = require('../config/supabaseClient');

// Every write to audit_log goes through here - keeps the shape consistent
// across all 4 action types, and means this table is only ever written
// by the service role, at the exact moment the real action happens, never
// something a client could fabricate or edit after the fact.
async function logAction({ businessId, actor, action, targetId, details }) {
  await supabaseAdmin.from('audit_log').insert({
    business_id: businessId,
    actor_id: actor?.id || null,
    actor_name: actor?.name || '',
    actor_role: actor?.role || '',
    action,
    target_id: targetId || null,
    details: details || {},
  });
}

module.exports = { logAction };

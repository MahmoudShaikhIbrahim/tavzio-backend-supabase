const asyncHandler = require('../utils/asyncHandler');
const { supabaseAdmin } = require('../config/supabaseClient');
const { logAction } = require('../utils/auditLog');

// ============================================================
// Super admin: organization + membership management
// ============================================================

const listOrganizations = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('organizations')
    .select('*, businesses(id, name, category, status)')
    .order('created_at', { ascending: false });
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

const createOrganization = asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ message: 'name is required' });
  const { data, error } = await supabaseAdmin.from('organizations').insert({ name }).select().single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

// @route PATCH /api/super-admin/businesses/:businessId/organization
// Body: { organizationId }  (null unlinks)
// Confirmed behavior: linking a location to an org is explicit and
// reversible, never assumed by name/owner matching - a wrong auto-match
// here would mean the wrong location suddenly inherits a shared menu.
const setBusinessOrganization = asyncHandler(async (req, res) => {
  const { organizationId } = req.body;
  const { data, error } = await supabaseAdmin
    .from('businesses')
    .update({ organization_id: organizationId || null })
    .eq('id', req.params.businessId)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ message: 'Business not found' });
  res.json(data);
});

// @route POST /api/super-admin/organizations/:organizationId/owner
// Body: { name, email }
// Creates a new org_owner account, same invite-by-email mechanism
// already used for staff. This account is deliberately NOT also a
// business_owner on any single location - its access is entirely
// org-scoped, authorized at the route layer below.
const inviteOrgOwner = asyncHandler(async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ message: 'name and email are required' });

  const { data: created, error: createError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
    data: { name, role: 'org_owner' },
  });
  if (createError) return res.status(400).json({ message: createError.message });

  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .update({ organization_id: req.params.organizationId, role: 'org_owner', must_change_password: true })
    .eq('id', created.user.id);
  if (profileError) return res.status(400).json({ message: profileError.message });

  res.status(201).json({ id: created.user.id, name, email, role: 'org_owner', organizationId: req.params.organizationId });
});

// ============================================================
// org_owner: reads/writes scoped to req.orgId, set by requireOrgOwner
// below - never trusts a client-supplied organizationId for anything
// that touches data, only ever req.user.organization_id from the
// authenticated profile itself.
// ============================================================

// Applied to every org_owner route below. super_admin may also act on
// behalf of any organization (for support), by passing ?organizationId=
// explicitly - never inferred, always an explicit query param so it's
// obvious in any request log which org a super_admin action touched.
function requireOrgOwner(req, res, next) {
  if (req.user.role === 'super_admin') {
    const orgId = req.query.organizationId || req.body.organizationId;
    if (!orgId) return res.status(400).json({ message: 'organizationId is required for super_admin requests' });
    req.orgId = orgId;
    return next();
  }
  if (req.user.role !== 'org_owner' || !req.user.organization_id) {
    return res.status(403).json({ message: 'Forbidden: org_owner access required' });
  }
  req.orgId = req.user.organization_id;
  next();
}

const getMyOrganization = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('organizations')
    .select('*, businesses(id, name, category, status, logo_url)')
    .eq('id', req.orgId)
    .single();
  if (error || !data) return res.status(404).json({ message: 'Organization not found' });
  res.json(data);
});

// --- Org master menu ---

const listOrgMenuCategories = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('organization_menu_categories')
    .select('*, organization_menu_items(*)')
    .eq('organization_id', req.orgId)
    .order('sort_order');
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

const createOrgMenuCategory = asyncHandler(async (req, res) => {
  const { name, sortOrder = 0 } = req.body;
  if (!name) return res.status(400).json({ message: 'name is required' });
  const { data, error } = await supabaseAdmin
    .from('organization_menu_categories')
    .insert({ organization_id: req.orgId, name, sort_order: sortOrder })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

const createOrgMenuItem = asyncHandler(async (req, res) => {
  const { categoryId, name, description = '', price, imageUrl = '' } = req.body;
  if (!name || price == null) return res.status(400).json({ message: 'name and price are required' });
  const { data, error } = await supabaseAdmin
    .from('organization_menu_items')
    .insert({ organization_id: req.orgId, category_id: categoryId || null, name, description, price, image_url: imageUrl })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

const updateOrgMenuItem = asyncHandler(async (req, res) => {
  const { name, description, price, imageUrl, categoryId } = req.body;
  const update = { updated_at: new Date().toISOString() };
  if (name !== undefined) update.name = name;
  if (description !== undefined) update.description = description;
  if (price !== undefined) update.price = price;
  if (imageUrl !== undefined) update.image_url = imageUrl;
  if (categoryId !== undefined) update.category_id = categoryId;

  const { data, error } = await supabaseAdmin
    .from('organization_menu_items')
    .update(update)
    .eq('id', req.params.itemId)
    .eq('organization_id', req.orgId)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ message: 'Item not found' });
  res.json(data);
});

const deleteOrgMenuItem = asyncHandler(async (req, res) => {
  const { error, count } = await supabaseAdmin
    .from('organization_menu_items')
    .delete({ count: 'exact' })
    .eq('id', req.params.itemId)
    .eq('organization_id', req.orgId);
  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Item not found' });
  res.json({ message: 'Item deleted - locations that already published it keep their existing copy' });
});

// @route POST /api/organizations/publish
// Body: { locationBusinessIds: string[] }
// The actual "push to locations" action. For every org master item:
// - if a location already has a linked copy (organization_source_id
//   matches), update its name/description/image, but never touch
//   price if that location has price_is_overridden set - that's the
//   confirmed "shared master, per-location price override" behavior.
// - if a location has no linked copy yet, create one at the master price.
// This never deletes a location's own independent (non-org) menu items -
// only rows already linked to this org's master are ever touched.
const publishMenuToLocations = asyncHandler(async (req, res) => {
  const { locationBusinessIds } = req.body;
  if (!Array.isArray(locationBusinessIds) || locationBusinessIds.length === 0) {
    return res.status(400).json({ message: 'locationBusinessIds is required' });
  }

  const { data: validLocations } = await supabaseAdmin
    .from('businesses')
    .select('id')
    .eq('organization_id', req.orgId)
    .in('id', locationBusinessIds);
  const validIds = (validLocations || []).map((b) => b.id);
  if (validIds.length === 0) return res.status(400).json({ message: 'None of those locations belong to this organization' });

  const { data: masterItems } = await supabaseAdmin
    .from('organization_menu_items')
    .select('*, organization_menu_categories(name)')
    .eq('organization_id', req.orgId);

  const results = { created: 0, updated: 0, locations: validIds.length };

  for (const locationId of validIds) {
    const { data: existingCategories } = await supabaseAdmin.from('menu_categories').select('id, name').eq('business_id', locationId);
    const categoryIdByName = Object.fromEntries((existingCategories || []).map((c) => [c.name, c.id]));

    for (const item of masterItems || []) {
      const categoryName = item.organization_menu_categories?.name;
      let categoryId = categoryName ? categoryIdByName[categoryName] : null;
      if (categoryName && !categoryId) {
        const { data: newCategory } = await supabaseAdmin
          .from('menu_categories')
          .insert({ business_id: locationId, name: categoryName })
          .select('id')
          .single();
        categoryId = newCategory?.id;
        categoryIdByName[categoryName] = categoryId;
      }

      const { data: existingItem } = await supabaseAdmin
        .from('menu_items')
        .select('id, price_is_overridden')
        .eq('organization_source_id', item.id)
        .eq('business_id', locationId)
        .maybeSingle();

      if (existingItem) {
        const update = { name: item.name, description: item.description, image_url: item.image_url, category_id: categoryId };
        if (!existingItem.price_is_overridden) update.price = item.price;
        await supabaseAdmin.from('menu_items').update(update).eq('id', existingItem.id);
        results.updated += 1;
      } else {
        await supabaseAdmin.from('menu_items').insert({
          business_id: locationId, category_id: categoryId,
          name: item.name, description: item.description, price: item.price, image_url: item.image_url,
          organization_source_id: item.id,
        });
        results.created += 1;
      }
    }
  }

  await logAction({ businessId: null, actor: req.user, action: 'org_menu_published', targetId: req.orgId, details: results });
  res.json({ message: `Published to ${validIds.length} location(s)`, ...results });
});

// --- Consolidated reporting ---

// @route GET /api/organizations/report?from=&to=
// Revenue per location plus a combined total - the actual point of
// having an organization at all, per the confirmed design: a
// consolidated view by default, not N separate dashboards to check by hand.
const getConsolidatedReport = asyncHandler(async (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString();
  const to = req.query.to || new Date().toISOString();

  const { data: locations } = await supabaseAdmin.from('businesses').select('id, name').eq('organization_id', req.orgId);
  if (!locations || locations.length === 0) return res.json({ from, to, locations: [], grandTotal: 0 });

  const locationIds = locations.map((l) => l.id);
  const { data: orders } = await supabaseAdmin
    .from('orders')
    .select('business_id, total, status')
    .in('business_id', locationIds)
    .neq('status', 'cancelled')
    .gte('created_at', from)
    .lte('created_at', to);

  const totalsByLocation = Object.fromEntries(locationIds.map((id) => [id, 0]));
  const countsByLocation = Object.fromEntries(locationIds.map((id) => [id, 0]));
  for (const o of orders || []) {
    totalsByLocation[o.business_id] = (totalsByLocation[o.business_id] || 0) + Number(o.total);
    countsByLocation[o.business_id] = (countsByLocation[o.business_id] || 0) + 1;
  }

  const results = locations.map((l) => ({
    businessId: l.id,
    name: l.name,
    orderCount: countsByLocation[l.id] || 0,
    total: Math.round((totalsByLocation[l.id] || 0) * 100) / 100,
  })).sort((a, b) => b.total - a.total);

  const grandTotal = results.reduce((sum, r) => sum + r.total, 0);
  res.json({ from, to, locations: results, grandTotal: Math.round(grandTotal * 100) / 100 });
});

module.exports = {
  listOrganizations, createOrganization, setBusinessOrganization, inviteOrgOwner,
  requireOrgOwner, getMyOrganization,
  listOrgMenuCategories, createOrgMenuCategory, createOrgMenuItem, updateOrgMenuItem, deleteOrgMenuItem,
  publishMenuToLocations, getConsolidatedReport,
};

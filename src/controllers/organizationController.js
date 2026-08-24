const asyncHandler = require('../utils/asyncHandler');
const { supabaseAdmin } = require('../config/supabaseClient');
const { logAction } = require('../utils/auditLog');
const { resendInviteEmail, sendNewInviteEmail, sendMail } = require('../utils/notifications');

// Shared by setBusinessOrganization (super-admin unlink) and
// leaveOrganization (self-service) below - same real gap, same fix in
// both places. organizations.organization_id lives on businesses AND on
// profiles as two separate columns; unlinking a business only ever
// touched the first one. An org_owner account whose HOME business
// (profiles.business_id) is the business being unlinked keeps its
// profiles.organization_id and every bit of org-level access completely
// untouched - fully active, fully privileged, no longer accountable to
// or manageable by any business anyone can see. That's the same failure
// shape as the orphaned account from earlier in this build, just
// produced going forward instead of found after the fact.
//
// Returns null if unlinking is safe, or a user-facing message if it
// would leave this organization with zero org_owner accounts anywhere.
// Deliberately checks ALL org_owners for the org, not just ones homed at
// this business - an org with a second owner elsewhere loses nothing by
// this business leaving, so only the true "last owner standing" case is
// blocked.
async function checkWouldOrphanOrgOwners(businessId, organizationId) {
  if (!organizationId) return null;
  const { data: owners, error } = await supabaseAdmin
    .from('profiles')
    .select('id, business_id')
    .eq('organization_id', organizationId)
    .eq('role', 'org_owner');
  if (error) return null; // fail open on a lookup error - don't block a real unlink over an unrelated read failure
  if (!owners || owners.length === 0) return null; // no org_owner exists at all yet - nothing to orphan

  const remaining = owners.filter((o) => o.business_id !== businessId);
  if (remaining.length === 0) {
    return 'This business is home to the only org owner account for this organization - reassign or remove that org owner first, or every other location loses org management along with this one leaving.';
  }
  return null;
}

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

// @route DELETE /api/super-admin/organizations/:organizationId
// Real, permanent removal. Deliberately refuses while ANY business is
// still linked - not an arbitrary caution, but load-bearing: organizations
// is referenced with `on delete cascade` by org-level menu categories/
// items (migration 0051), warehouses (0089), and suppliers/purchase
// orders (0090). A raw delete on an org with active locations wouldn't
// just remove an empty row - it would silently wipe out real, currently-
// used shared menu items, warehouses, suppliers, and purchase order
// history out from under every member business, with no warning and no
// way back. Requiring zero linked businesses first (via the existing
// unlink action) means that by the time this can succeed, the cascade
// has nothing real left to destroy - it's cleaning up an already-empty
// shell, not taking data out from under anyone.
//
// businesses.organization_id and profiles.organization_id are both
// `on delete set null` (not cascade) - so even in the all-clear case,
// any stray profile still pointing at this org (shouldn't exist once
// every business is unlinked and every org_owner reassigned, but just
// in case) is safely detached rather than deleted outright.
const deleteOrganization = asyncHandler(async (req, res) => {
  const { data: linked, error: linkedError } = await supabaseAdmin
    .from('businesses')
    .select('id, name')
    .eq('organization_id', req.params.organizationId);
  if (linkedError) return res.status(400).json({ message: linkedError.message });
  if (linked && linked.length > 0) {
    return res.status(400).json({
      message: `Unlink every location first - ${linked.length} still linked (${linked.map((b) => b.name).join(', ')}).`,
    });
  }

  const { data: org, error } = await supabaseAdmin
    .from('organizations')
    .delete()
    .eq('id', req.params.organizationId)
    .select('id, name')
    .maybeSingle();
  if (error) return res.status(400).json({ message: error.message });
  if (!org) return res.status(404).json({ message: 'Organization not found' });

  await logAction({
    businessId: null,
    actor: req.user,
    action: 'organization_deleted',
    targetId: org.id,
    details: { organizationName: org.name },
  });

  res.json({ message: 'Organization deleted', id: org.id });
});

// @route PATCH /api/super-admin/businesses/:businessId/organization
// Body: { organizationId }  (null unlinks)
// Confirmed behavior: linking a location to an org is explicit and
// reversible, never assumed by name/owner matching - a wrong auto-match
// here would mean the wrong location suddenly inherits a shared menu.
const setBusinessOrganization = asyncHandler(async (req, res) => {
  const { organizationId } = req.body;

  if (!organizationId) {
    const { data: business } = await supabaseAdmin.from('businesses').select('organization_id').eq('id', req.params.businessId).maybeSingle();
    if (business?.organization_id) {
      const orphanMessage = await checkWouldOrphanOrgOwners(req.params.businessId, business.organization_id);
      if (orphanMessage) return res.status(400).json({ message: orphanMessage });
    }
  }

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

  const { data: org } = await supabaseAdmin.from('organizations').select('name').eq('id', req.params.organizationId).maybeSingle();
  const redirectTo = `${process.env.CLIENT_URL}/admin/login`;

  // Same real fix as staffController.js's inviteStaff, same reasoning:
  // generateLink-based sendNewInviteEmail (see notifications.js) never
  // lets Supabase send anything itself, and Resend sends the actual
  // email on Tavzio's own verified domain instead.
  let created;
  try {
    created = await sendNewInviteEmail({
      email, name, businessLabel: org?.name || 'Tavzio', redirectTo,
      userMetadata: { name, role: 'org_owner' },
    });
  } catch (createError) {
    // Same fallback as inviteStaff, same reasoning: clicking "Invite" a
    // second time for someone who never checked their first email used
    // to just fail with "already registered" and no way forward. Since
    // this org invite form has no separate list of pending invites to
    // attach a dedicated "Resend" button to, making the invite button
    // itself idempotent this way is the real fix, not a UI addition.
    if (createError.message && createError.message.toLowerCase().includes('already been registered')) {
      const { data: existing } = await supabaseAdmin.auth.admin.listUsers();
      const existingUser = existing?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
      if (!existingUser) return res.status(400).json({ message: createError.message });

      await supabaseAdmin
        .from('profiles')
        .update({ organization_id: req.params.organizationId, role: 'org_owner', must_change_password: true })
        .eq('id', existingUser.id);

      await resendInviteEmail({ email, name, businessLabel: org?.name || 'Tavzio', redirectTo });

      return res.status(200).json({ id: existingUser.id, name, email, role: 'org_owner', organizationId: req.params.organizationId, resent: true });
    }
    return res.status(400).json({ message: createError.message });
  }

  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .update({ organization_id: req.params.organizationId, role: 'org_owner', must_change_password: true })
    .eq('id', created.id);
  if (profileError) return res.status(400).json({ message: profileError.message });

  res.status(201).json({ id: created.id, name, email, role: 'org_owner', organizationId: req.params.organizationId });
});

// ============================================================
// Self-service: business owner creates their own org + appoints an
// org_owner (possibly themselves), no super_admin involved. Deliberately
// narrower than the super_admin path above: this can only ever create a
// NEW org and link/appoint within the caller's OWN business - it can
// never attach an existing org (so it can never pull a second, unrelated
// business into one), and it never lets one business_id touch another's
// profiles/org membership. Cross-business linking (the real multi-
// tenant-franchise case) stays exclusively on setBusinessOrganization/
// inviteOrgOwner above, gated to super_admin - a deliberate trust
// boundary: two separate businesses sharing a menu/reporting/suppliers
// is a decision between two owners (or their platform), not something
// either owner can do unilaterally to the other's data.
// ============================================================

// @route GET /api/businesses/:businessId/organization
// Cheap status check the frontend uses to decide whether to show
// "Set up multi-location" or the existing org's name/owners.
const getBusinessOrganization = asyncHandler(async (req, res) => {
  const { data: business, error: bizError } = await req.supabase
    .from('businesses')
    .select('organization_id')
    .eq('id', req.params.businessId)
    .single();
  if (bizError || !business) return res.status(404).json({ message: 'Business not found' });
  if (!business.organization_id) return res.json(null);

  const { data: org, error } = await supabaseAdmin
    .from('organizations')
    .select('id, name, created_at')
    .eq('id', business.organization_id)
    .single();
  if (error || !org) return res.json(null);
  res.json(org);
});

// @route POST /api/businesses/:businessId/organization/owner
// Body EITHER { name, email } to invite a brand-new org_owner account,
// OR { staffId } to promote an existing staff member on this same
// business into the role instead - covers "I'll appoint myself" (staffId
// = the owner's own profile id) and "appoint someone already on my team"
// without a second, duplicate invite email.
//
// Creates the organization itself on first call if this business isn't
// already linked to one (name defaults to the business's own name,
// overridable via body.orgName) - one action does both "set up multi-
// location" and "appoint the first owner," matching how an owner
// actually thinks about this (they're not managing an abstract org
// shell, they're deciding who runs their multi-location setup).
//
// business_id is deliberately set on the resulting profile (see
// migration 0096) alongside organization_id - purely so this account
// shows up on and can be deleted from THIS business's Staff page. Every
// actual org-data route (organizationRoutes.js) still authorizes purely
// off organization_id via requireOrgOwner, unaffected by business_id
// being set here.
const appointOrgOwner = asyncHandler(async (req, res) => {
  const { name, email, staffId, orgName } = req.body;
  if (!staffId && (!name || !email)) {
    return res.status(400).json({ message: 'Provide either staffId, or name and email' });
  }

  const { data: business, error: bizError } = await supabaseAdmin
    .from('businesses')
    .select('id, name, organization_id')
    .eq('id', req.params.businessId)
    .single();
  if (bizError || !business) return res.status(404).json({ message: 'Business not found' });

  let organizationId = business.organization_id;
  if (!organizationId) {
    const { data: org, error: orgError } = await supabaseAdmin
      .from('organizations')
      .insert({ name: orgName || business.name })
      .select('id')
      .single();
    if (orgError) return res.status(400).json({ message: orgError.message });
    organizationId = org.id;

    const { error: linkError } = await supabaseAdmin
      .from('businesses')
      .update({ organization_id: organizationId })
      .eq('id', business.id);
    if (linkError) return res.status(400).json({ message: linkError.message });
  }

  // Promote an existing team member - no invite email needed, they
  // already have a working login.
  if (staffId) {
    const { data: staffMember } = await supabaseAdmin
      .from('profiles')
      .select('id, name, role')
      .eq('id', staffId)
      .eq('business_id', req.params.businessId)
      .maybeSingle();
    if (!staffMember) return res.status(404).json({ message: 'Staff member not found on this business' });

    const { data: updated, error } = await supabaseAdmin
      .from('profiles')
      .update({ role: 'org_owner', organization_id: organizationId })
      .eq('id', staffId)
      .select('id, name, role, organization_id')
      .single();
    if (error) return res.status(400).json({ message: error.message });

    await logAction({
      businessId: req.params.businessId,
      actor: req.user,
      action: 'org_owner_appointed',
      targetId: updated.id,
      details: { accountName: updated.name, mode: 'promoted' },
    });

    return res.status(200).json(updated);
  }

  // Invite a brand-new person - same real invite-by-email mechanism as
  // inviteStaff/inviteOrgOwner (see notifications.js), same idempotent
  // fallback for a repeat click on someone who never checked their
  // first email.
  const redirectTo = `${process.env.CLIENT_URL}/admin/login`;
  let created;
  try {
    created = await sendNewInviteEmail({
      email, name, businessLabel: business.name, redirectTo,
      userMetadata: { name, role: 'org_owner' },
    });
  } catch (createError) {
    if (createError.message && createError.message.toLowerCase().includes('already been registered')) {
      const { data: existing } = await supabaseAdmin.auth.admin.listUsers();
      const existingUser = existing?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());
      if (!existingUser) return res.status(400).json({ message: createError.message });

      await supabaseAdmin
        .from('profiles')
        .update({ business_id: req.params.businessId, organization_id: organizationId, role: 'org_owner' })
        .eq('id', existingUser.id);

      await resendInviteEmail({ email, name, businessLabel: business.name, redirectTo });

      return res.status(200).json({ id: existingUser.id, name, email, role: 'org_owner', organizationId, resent: true });
    }
    return res.status(400).json({ message: createError.message });
  }

  const { error: profileError } = await supabaseAdmin
    .from('profiles')
    .update({ business_id: req.params.businessId, organization_id: organizationId, role: 'org_owner' })
    .eq('id', created.id);
  if (profileError) return res.status(400).json({ message: profileError.message });

  await logAction({
    businessId: req.params.businessId,
    actor: req.user,
    action: 'org_owner_appointed',
    targetId: created.id,
    details: { accountName: name, mode: 'invited' },
  });

  res.status(201).json({ id: created.id, name, email, role: 'org_owner', organizationId });
});

// @route DELETE /api/businesses/:businessId/organization
// Self-service unlink - the symmetric counterpart to appointOrgOwner's
// self-service create above. Only ever touches this one business's own
// businesses.organization_id column, exactly like creation only ever
// touched this one business - it can't reach or affect any other
// member's link to the org. Uses the same checkWouldOrphanOrgOwners
// guard as the super-admin unlink path (setBusinessOrganization) above,
// for the same reason: leaving shouldn't silently strand every other
// member business without anyone who can manage the org they're still
// part of.
const leaveOrganization = asyncHandler(async (req, res) => {
  const { data: business, error: bizError } = await supabaseAdmin
    .from('businesses')
    .select('id, name, organization_id')
    .eq('id', req.params.businessId)
    .single();
  if (bizError || !business) return res.status(404).json({ message: 'Business not found' });
  if (!business.organization_id) return res.status(400).json({ message: 'This business is not part of an organization' });

  const orphanMessage = await checkWouldOrphanOrgOwners(req.params.businessId, business.organization_id);
  if (orphanMessage) return res.status(400).json({ message: orphanMessage });

  const { error } = await supabaseAdmin
    .from('businesses')
    .update({ organization_id: null })
    .eq('id', req.params.businessId);
  if (error) return res.status(400).json({ message: error.message });

  await logAction({
    businessId: req.params.businessId,
    actor: req.user,
    action: 'organization_left',
    targetId: business.organization_id,
    details: { organizationId: business.organization_id },
  });

  res.json({ message: 'Left organization' });
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

// @route GET /api/organizations/report/hotel?from=&to=
// The real gap in multi-property: getConsolidatedReport above only
// rolls up order revenue - zero hotel metrics, so a hotel group had no
// way to compare properties on the numbers that actually matter for a
// hotel: occupancy, ADR (average daily rate - room revenue per room
// actually sold), and RevPAR (revenue per available room - the
// standard industry metric that accounts for rooms that sat empty, not
// just the ones that sold). Scoped to hotel-category locations only -
// a restaurant location in the same org has no room inventory to report on.
const getHotelConsolidatedReport = asyncHandler(async (req, res) => {
  const from = req.query.from || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const to = req.query.to || new Date().toISOString().slice(0, 10);

  const { data: locations } = await supabaseAdmin.from('businesses').select('id, name').eq('organization_id', req.orgId).eq('category', 'hotel');
  if (!locations || locations.length === 0) return res.json({ from, to, locations: [], orgTotals: null });

  const locationIds = locations.map((l) => l.id);
  const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / 86400000) + 1);

  const { data: rooms } = await supabaseAdmin.from('hotel_rooms').select('id, business_id').in('business_id', locationIds).neq('status', 'out_of_order');
  const { data: audits } = await supabaseAdmin
    .from('hotel_night_audits')
    .select('business_id, room_revenue_aed, rooms_sold, rooms_available')
    .in('business_id', locationIds)
    .gte('business_date', from)
    .lte('business_date', to);

  const roomsAvailableByLocation = {};
  for (const r of rooms || []) roomsAvailableByLocation[r.business_id] = (roomsAvailableByLocation[r.business_id] || 0) + 1;

  const results = locations.map((l) => {
    const locationAudits = (audits || []).filter((a) => a.business_id === l.id);
    const roomRevenueAed = locationAudits.reduce((sum, a) => sum + Number(a.room_revenue_aed), 0);
    const roomNightsSold = locationAudits.reduce((sum, a) => sum + Number(a.rooms_sold), 0);
    // Uses the room count as of now, times the number of audited days in
    // range, as the available-room-nights denominator - the same
    // approach a real RevPAR calculation uses when a property's room
    // count hasn't changed mid-period, which is the normal case.
    const roomsAvailable = roomsAvailableByLocation[l.id] || 0;
    const availableRoomNights = roomsAvailable * locationAudits.length;
    const occupancyPct = availableRoomNights > 0 ? Math.round((roomNightsSold / availableRoomNights) * 1000) / 10 : null;
    const adrAed = roomNightsSold > 0 ? Math.round((roomRevenueAed / roomNightsSold) * 100) / 100 : null;
    const revParAed = availableRoomNights > 0 ? Math.round((roomRevenueAed / availableRoomNights) * 100) / 100 : null;

    return {
      businessId: l.id,
      name: l.name,
      roomsAvailable,
      auditedDays: locationAudits.length,
      roomRevenueAed: Math.round(roomRevenueAed * 100) / 100,
      occupancyPct,
      adrAed,
      revParAed,
    };
  }).sort((a, b) => (b.revParAed || 0) - (a.revParAed || 0));

  const totalRoomRevenueAed = results.reduce((sum, r) => sum + r.roomRevenueAed, 0);
  const totalRoomsAvailable = results.reduce((sum, r) => sum + r.roomsAvailable, 0);

  res.json({
    from, to, days,
    locations: results,
    orgTotals: {
      totalRoomRevenueAed: Math.round(totalRoomRevenueAed * 100) / 100,
      totalRoomsAvailable,
      locationsWithNoAuditData: results.filter((r) => r.auditedDays === 0).length,
    },
  });
});

// --- Org-level supply chain: shared suppliers, purchase orders split
// across member businesses. See migrations 0090/0091 for the schema
// reasoning - suppliers/POs here carry organization_id instead of
// business_id, and ingredient_id on a PO item is intentionally absent
// until allocation, since an org-level item has no single business's
// ingredient to reference yet. ---

const listOrgSuppliers = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('suppliers')
    .select('*')
    .eq('organization_id', req.orgId)
    .order('name');
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

const createOrgSupplier = asyncHandler(async (req, res) => {
  const { name, contactName = '', phone = '', email = '' } = req.body;
  if (!name) return res.status(400).json({ message: 'name is required' });
  const { data, error } = await supabaseAdmin
    .from('suppliers')
    .insert({ name, contact_name: contactName, phone, email, organization_id: req.orgId })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });
  res.status(201).json(data);
});

const updateOrgSupplier = asyncHandler(async (req, res) => {
  const { name, contactName, phone, email } = req.body;
  const update = {};
  if (name !== undefined) update.name = name;
  if (contactName !== undefined) update.contact_name = contactName;
  if (phone !== undefined) update.phone = phone;
  if (email !== undefined) update.email = email;

  const { data, error } = await supabaseAdmin
    .from('suppliers')
    .update(update)
    .eq('id', req.params.supplierId)
    .eq('organization_id', req.orgId)
    .select()
    .single();
  if (error || !data) return res.status(404).json({ message: 'Supplier not found' });
  res.json(data);
});

const deleteOrgSupplier = asyncHandler(async (req, res) => {
  const { error, count } = await supabaseAdmin
    .from('suppliers')
    .delete({ count: 'exact' })
    .eq('id', req.params.supplierId)
    .eq('organization_id', req.orgId);
  if (error) return res.status(400).json({ message: error.message });
  if (!count) return res.status(404).json({ message: 'Supplier not found' });
  res.json({ message: 'Deleted' });
});

const listOrgPurchaseOrders = asyncHandler(async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('purchase_orders')
    .select('*, suppliers(name), purchase_order_items(id, item_name, item_unit, quantity, unit_cost_aed, purchase_order_allocations(id, business_id, quantity, received, businesses(name)))')
    .eq('organization_id', req.orgId)
    .order('ordered_at', { ascending: false });
  if (error) return res.status(400).json({ message: error.message });
  res.json(data);
});

// @route POST /api/organizations/purchase-orders
// Body: { supplierId, items: [{ itemName, itemUnit, quantity, unitCostAed, allocations: [{ businessId, quantity }] }] }
// One PO, one supplier relationship, split however the org_owner wants
// across whichever member businesses actually need a share - buying in
// bulk, distributing afterward. Each item's allocations must add up to
// no more than the item's total ordered quantity - enforced here, not
// left to the org_owner to get right by hand.
// Emails the supplier a plain-text summary of what was ordered - this
// used to only ever write internal DB rows (org's own tracking), with
// no way for the actual supplier to find out an order exists short of
// someone calling them. Uses the same Gmail-API sendMail as the rest of
// the app (silently no-ops, logged not thrown, if ALERT_FROM_EMAIL/Gmail
// creds aren't set - same graceful-missing-config pattern as everywhere
// else), so placing an order never fails just because the email step
// can't go out.
async function notifySupplierOfOrder({ supplier, orgName, items, totalCostAed }) {
  if (!supplier?.email) return;
  const lines = items.map((i) => `- ${i.quantity} ${i.itemUnit || ''} ${i.itemName} @ AED ${Number(i.unitCostAed).toFixed(2)}/unit`);
  const text = [
    `New purchase order from ${orgName}.`,
    '',
    ...lines,
    '',
    `Total: AED ${totalCostAed.toFixed(2)}`,
    '',
    'Please confirm receipt of this order and expected delivery timing.',
  ].join('\n');
  try {
    await sendMail({ to: supplier.email, subject: `New purchase order from ${orgName}`, text });
  } catch (err) {
    console.error('Supplier order email failed:', err.message);
  }
}

const createOrgPurchaseOrder = asyncHandler(async (req, res) => {
  const { supplierId, items } = req.body;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'At least one item is required' });
  }
  for (const item of items) {
    const allocated = (item.allocations || []).reduce((sum, a) => sum + Number(a.quantity), 0);
    if (allocated > Number(item.quantity)) {
      return res.status(400).json({ message: `"${item.itemName}" is allocated to businesses for more than was ordered (${allocated} allocated, ${item.quantity} ordered).` });
    }
  }

  const totalCostAed = items.reduce((sum, i) => sum + Number(i.quantity) * Number(i.unitCostAed), 0);

  const { data: po, error } = await supabaseAdmin
    .from('purchase_orders')
    .insert({ organization_id: req.orgId, supplier_id: supplierId || null, total_cost_aed: totalCostAed, created_by: req.user.id })
    .select()
    .single();
  if (error) return res.status(400).json({ message: error.message });

  for (const item of items) {
    const { data: poItem, error: itemError } = await supabaseAdmin
      .from('purchase_order_items')
      .insert({
        purchase_order_id: po.id,
        item_name: item.itemName,
        item_unit: item.itemUnit || '',
        quantity: Number(item.quantity),
        unit_cost_aed: Number(item.unitCostAed),
      })
      .select()
      .single();
    if (itemError) return res.status(400).json({ message: itemError.message });

    if (item.allocations && item.allocations.length > 0) {
      const allocationRows = item.allocations.map((a) => ({
        purchase_order_item_id: poItem.id,
        business_id: a.businessId,
        quantity: Number(a.quantity),
      }));
      const { error: allocError } = await supabaseAdmin.from('purchase_order_allocations').insert(allocationRows);
      if (allocError) return res.status(400).json({ message: allocError.message });
    }
  }

  await logAction({
    businessId: null,
    actor: req.user,
    action: 'org_purchase_order_created',
    targetId: po.id,
    details: { organizationId: req.orgId, itemCount: items.length, totalCostAed },
  });

  if (supplierId) {
    const [{ data: supplier }, { data: org }] = await Promise.all([
      supabaseAdmin.from('suppliers').select('email').eq('id', supplierId).maybeSingle(),
      supabaseAdmin.from('organizations').select('name').eq('id', req.orgId).maybeSingle(),
    ]);
    await notifySupplierOfOrder({ supplier, orgName: org?.name || 'Tavzio', items, totalCostAed });
  }

  res.status(201).json(po);
});

module.exports = {
  listOrganizations, createOrganization, deleteOrganization, setBusinessOrganization, inviteOrgOwner,
  getBusinessOrganization, appointOrgOwner, leaveOrganization,
  requireOrgOwner, getMyOrganization,
  listOrgMenuCategories, createOrgMenuCategory, createOrgMenuItem, updateOrgMenuItem, deleteOrgMenuItem,
  publishMenuToLocations, getConsolidatedReport, getHotelConsolidatedReport,
  listOrgSuppliers, createOrgSupplier, updateOrgSupplier, deleteOrgSupplier,
  listOrgPurchaseOrders, createOrgPurchaseOrder,
};

// Shared across every place a URL-safe slug gets derived from a name -
// previously three separate, near-identical copies of this exact same
// logic (digitalCardController.js for digital_cards, contractController.js
// for businesses, and now businessController.js for a business's own
// slug following its name) - one implementation now, not three that can
// quietly drift apart from each other over time.
function slugify(text) {
  return text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'business';
}

// excludeId matters specifically for an UPDATE (as opposed to a create):
// recomputing a business's own slug from its own current name would
// otherwise always find its own existing row as a "collision" and
// needlessly append a suffix to its own unchanged slug every time.
async function uniqueSlug(supabaseAdmin, table, base, { excludeId } = {}) {
  const baseSlug = slugify(base);
  let slug = baseSlug;
  let suffix = 1;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let query = supabaseAdmin.from(table).select('id').eq('slug', slug);
    if (excludeId) query = query.neq('id', excludeId);
    const { data: existing } = await query.maybeSingle();
    if (!existing) return slug;
    suffix += 1;
    slug = `${baseSlug}-${suffix}`;
  }
}

module.exports = { slugify, uniqueSlug };

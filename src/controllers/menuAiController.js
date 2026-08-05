const asyncHandler = require('../utils/asyncHandler');
const { translateToAllLanguages } = require('../utils/translate');
const { extractMenuFromFiles } = require('../utils/menuAiExtractor');

// @route POST /api/businesses/:businessId/menu/ai/extract
// multipart/form-data, field name "files" - one PDF, one Excel/CSV, or
// multiple photos. Streams newline-delimited JSON back instead of a
// single response: periodic {"type":"ping"} lines while Claude is still
// working (this is what keeps the connection alive through a long
// extraction on a big menu - both the browser's own timeout and
// Railway's proxy timeout are about IDLE time, not total time, so
// active writes prevent either from killing the request), then one
// final {"type":"result","data":{...}} or {"type":"error","message":...}
// line before the response ends. Nothing is written to the menu here -
// this is reviewed and edited by a human before anything goes live, via
// the separate /publish endpoint below.
const extractMenu = asyncHandler(async (req, res) => {
  const files = req.files || [];
  if (files.length === 0) {
    return res.status(400).json({ message: 'No files were uploaded' });
  }
  // Basic sanity cap - the multer config below also caps this, this is
  // just a clearer error message than a multipart parse failure would give.
  if (files.length > 25) {
    return res.status(400).json({ message: 'Too many files - please upload up to 25 at a time' });
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no', // disables nginx-style response buffering some proxies apply, so pings actually reach the client as they're written rather than getting queued
  });

  // Throttled rather than firing on every single stream event (which can
  // be many per second) - the goal is "never let the connection sit
  // idle long enough to time out," not "relay every token." A ping
  // every couple of seconds is more than enough for that.
  let lastPing = 0;
  function onActivity() {
    const now = Date.now();
    if (now - lastPing > 2000) {
      lastPing = now;
      res.write(JSON.stringify({ type: 'ping' }) + '\n');
    }
  }

  try {
    const result = await extractMenuFromFiles(files, req.params.businessId, onActivity);
    res.write(JSON.stringify({ type: 'result', data: result }) + '\n');
  } catch (err) {
    res.write(JSON.stringify({ type: 'error', message: err.message || 'Could not read the menu from these files' }) + '\n');
  } finally {
    res.end();
  }
});

// @route POST /api/businesses/:businessId/menu/ai/publish
// Body: { categories: [{ name, items: [{ name, price, description?, photoUrl?, currency? }] }] }
// This is the ONLY place an AI-extracted menu actually becomes real menu
// data - always called explicitly after a human has reviewed (and
// possibly edited) the draft from /extract. Reuses the exact same
// insert + translation pipeline as manually creating categories/items
// one at a time, just looped, so an AI-uploaded menu behaves identically
// to a hand-typed one from this point on (translations, sold-out
// toggles, everything).
const publishMenu = asyncHandler(async (req, res) => {
  const { categories } = req.body;
  if (!Array.isArray(categories) || categories.length === 0) {
    return res.status(400).json({ message: 'No categories to publish' });
  }

  let categoriesCreated = 0;
  let itemsCreated = 0;
  const errors = [];

  for (let ci = 0; ci < categories.length; ci++) {
    const category = categories[ci];
    if (!category?.name) continue;

    const nameI18n = await translateToAllLanguages(category.name).catch(() => ({}));
    const { data: categoryRow, error: categoryError } = await req.supabase
      .from('menu_categories')
      .insert({ business_id: req.params.businessId, name: category.name, sort_order: ci, name_i18n: nameI18n })
      .select()
      .single();

    if (categoryError || !categoryRow) {
      errors.push(`Category "${category.name}": ${categoryError?.message || 'could not be created'}`);
      continue;
    }
    categoriesCreated += 1;

    const items = Array.isArray(category.items) ? category.items : [];
    for (let ii = 0; ii < items.length; ii++) {
      const item = items[ii];
      if (!item?.name) continue;

      const [itemNameI18n, descriptionI18n] = await Promise.all([
        translateToAllLanguages(item.name).catch(() => ({})),
        item.description ? translateToAllLanguages(item.description).catch(() => ({})) : Promise.resolve({}),
      ]);

      const { error: itemError } = await req.supabase.from('menu_items').insert({
        business_id: req.params.businessId,
        category_id: categoryRow.id,
        name: item.name,
        name_i18n: itemNameI18n,
        description: item.description || '',
        description_i18n: descriptionI18n,
        price: item.price || 0,
        image_url: item.photoUrl || '',
        sort_order: ii,
      });

      if (itemError) errors.push(`Item "${item.name}": ${itemError.message}`);
      else itemsCreated += 1;
    }
  }

  res.status(201).json({ categoriesCreated, itemsCreated, errors });
});

module.exports = { extractMenu, publishMenu };

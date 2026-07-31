const Anthropic = require('@anthropic-ai/sdk');
const XLSX = require('xlsx');
const sharp = require('sharp');
const { randomUUID } = require('crypto');
const { supabaseAdmin } = require('../config/supabaseClient');

// =========================================================================
// AI menu extraction (upload → structured draft, never a direct publish)
// =========================================================================
// Hard rules this whole module exists to enforce, per explicit decision:
// 1. A description is included ONLY if the source menu already has one -
//    never generated/invented, even when the item clearly has no
//    description and one "would help."
// 2. A photo is attached to an item ONLY if the source upload genuinely
//    contains a real photo of that dish - never AI-generated, never a
//    stock substitute. If there's no source photo, the item's photo
//    field is simply omitted.
// 3. Anything too unclear to read confidently (blurry, dark, cropped,
//    low-resolution) is never guessed at - it's reported back by index
//    so the specific page/photo can be re-uploaded, while everything
//    else that WAS readable still comes through.
// 4. Nothing in this file writes to the menu tables - this only ever
//    produces a draft for a human to review. Publishing is a separate,
//    explicit step (menuAiController.publishMenu).
// =========================================================================

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const EXTRACTION_SYSTEM_PROMPT = `You are reading a restaurant's menu from an upload (PDF pages, photos of a printed menu, or a spreadsheet dump) and structuring it for a menu-management system. Follow these rules exactly:

1. Extract every category, item name, and price you can read. Prices are plain numbers (e.g. 45 or 45.50) in the menu's own currency - if a currency symbol/code is visible and is NOT AED, include it in a "currency" field on that item so a human can double check; if AED or unmarked (assume AED), omit the currency field.
2. Only include a "description" field for an item if the menu text ITSELF already contains a description for it. If an item has no description in the source, do not write one - omit the field entirely. Never invent, infer, or embellish a description.
3. Only include a "photo" field for an item if the upload genuinely contains a real photograph of that specific dish next to or clearly associated with it. When it does, give the 0-indexed image index (matching the order images were provided to you) and a tight bounding box around JUST that dish photo as fractions of that image's width/height: {"imageIndex": 0, "x": 0.05, "y": 0.10, "width": 0.40, "height": 0.30} (x,y = top-left corner). If there is no real source photo for an item, omit the "photo" field entirely - never invent one.
4. If a specific image you were given is too blurry, dark, poorly cropped, or low-resolution to read confidently, do NOT guess at its contents. Instead add an entry to "unclear": [{"imageIndex": N, "reason": "short specific reason"}], and skip extracting items from that one image only - keep extracting everything you CAN read confidently from the other images/pages.
5. Respond with ONLY raw JSON, no markdown code fences, no commentary before or after. Exact shape:
{
  "categories": [
    {
      "name": "string",
      "items": [
        {
          "name": "string",
          "price": 0,
          "currency": "string (optional, only if not AED)",
          "description": "string (optional, only if genuinely present in source)",
          "photo": {"imageIndex": 0, "x": 0, "y": 0, "width": 0, "height": 0} (optional, only if a real source photo exists)
        }
      ]
    }
  ],
  "unclear": [{"imageIndex": 0, "reason": "string"}]
}`;

function mimeFromFilename(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/jpeg';
}

// Excel/CSV isn't sent as vision input - it's parsed into a plain text
// table first, which is both more reliable (no OCR guesswork on
// already-structured data) and far cheaper than sending it as an image.
function excelToText(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const parts = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet);
    if (csv.trim()) parts.push(`--- Sheet: ${sheetName} ---\n${csv}`);
  }
  return parts.join('\n\n');
}

// Crops the bounding box Claude reported out of the ORIGINAL uploaded
// image and uploads just that crop to Storage - this is what makes a
// "photo" field a real, usable image URL rather than just coordinates.
// Only applies to actual image uploads; PDF pages aren't rendered to
// images in this version, so photo extraction from a PDF menu isn't
// supported yet (documented limitation, not a silent gap).
async function cropAndUploadPhoto(imageBuffers, photo, businessId) {
  const source = imageBuffers[photo.imageIndex];
  if (!source) return null;

  try {
    const meta = await sharp(source).metadata();
    const width = meta.width || 0;
    const height = meta.height || 0;
    if (!width || !height) return null;

    const left = Math.max(0, Math.round(photo.x * width));
    const top = Math.max(0, Math.round(photo.y * height));
    const cropWidth = Math.max(1, Math.min(width - left, Math.round(photo.width * width)));
    const cropHeight = Math.max(1, Math.min(height - top, Math.round(photo.height * height)));

    const cropped = await sharp(source)
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .jpeg({ quality: 85 })
      .toBuffer();

    const path = `${businessId}/menu-ai/${randomUUID()}.jpg`;
    const { error } = await supabaseAdmin.storage
      .from('business-assets')
      .upload(path, cropped, { contentType: 'image/jpeg', upsert: false });
    if (error) return null;

    const { data } = supabaseAdmin.storage.from('business-assets').getPublicUrl(path);
    return data.publicUrl;
  } catch {
    // A bad bounding box (out of range, degenerate size) shouldn't take
    // down the whole extraction - the item just ends up with no photo,
    // same as if the source genuinely had none.
    return null;
  }
}

// `files` is an array of multer file objects: { originalname, mimetype, buffer }.
// Returns { categories, unclear, warnings } - never touches the database.
async function extractMenuFromFiles(files, businessId) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }
  if (!files || files.length === 0) {
    throw new Error('No files were uploaded');
  }

  const imageBuffers = []; // only real image uploads, in order - used for cropping later
  const content = [];
  const warnings = [];

  for (const file of files) {
    const isPdf = file.mimetype === 'application/pdf';
    const isExcel = /spreadsheetml|ms-excel|csv/.test(file.mimetype) || /\.(xlsx|xls|csv)$/i.test(file.originalname);
    const isImage = file.mimetype.startsWith('image/');

    if (isPdf) {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: file.buffer.toString('base64') },
      });
      // PDFs don't get an imageBuffers slot - bounding-box photo
      // cropping only applies to genuine image uploads (see
      // cropAndUploadPhoto's comment). Claude can still read a PDF's
      // text/prices/descriptions fine, it just won't produce a "photo"
      // field for items sourced from a PDF page.
    } else if (isImage) {
      imageBuffers.push(file.buffer);
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: mimeFromFilename(file.originalname), data: file.buffer.toString('base64') },
      });
    } else if (isExcel) {
      const text = excelToText(file.buffer);
      content.push({ type: 'text', text: `Spreadsheet "${file.originalname}":\n\n${text}` });
    } else {
      warnings.push(`Skipped "${file.originalname}" - unsupported file type (${file.mimetype})`);
    }
  }

  if (content.length === 0) {
    throw new Error('None of the uploaded files could be read (unsupported types)');
  }

  content.push({ type: 'text', text: 'Extract the full menu from the material above, following the rules exactly.' });

  const response = await anthropic.messages.create({
    // Haiku 4.5 - roughly 3.75x cheaper than Sonnet, and well suited to
    // structured extraction tasks like this one. Using the full dated
    // snapshot id deliberately (not a bare alias) so this never silently
    // shifts to a different model later - if Anthropic ever retires this
    // exact snapshot, the call will fail loudly with an error rather
    // than quietly changing behavior, and the fix is a one-line update
    // here. The mandatory review screen (nothing publishes automatically)
    // is what actually makes a cheaper model safe to use here - a wrong
    // price or an odd photo crop gets caught by the owner, not shipped
    // straight to customers.
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8000,
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('The AI did not return a readable response');

  let parsed;
  try {
    // Defensive: strip accidental markdown fences even though the
    // prompt says not to use them - cheap insurance against an
    // occasional non-compliant response breaking the whole upload.
    const cleaned = textBlock.text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('The AI response could not be parsed - please try again');
  }

  const categories = Array.isArray(parsed.categories) ? parsed.categories : [];
  const unclear = Array.isArray(parsed.unclear) ? parsed.unclear : [];

  // Resolve every reported photo bounding box into an actual uploaded
  // crop URL now, so the review screen just gets a plain image to show -
  // no coordinates or cropping logic needs to leak into the frontend.
  for (const category of categories) {
    for (const item of category.items || []) {
      if (item.photo && typeof item.photo.imageIndex === 'number') {
        const url = await cropAndUploadPhoto(imageBuffers, item.photo, businessId);
        if (url) item.photoUrl = url;
        delete item.photo;
      }
    }
  }

  return { categories, unclear, warnings };
}

module.exports = { extractMenuFromFiles };

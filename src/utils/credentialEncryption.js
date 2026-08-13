// =========================================================================
// Credential encryption at rest
// =========================================================================
// Payment gateway secret keys, POS integration tokens, and printer API
// keys were being stored as plain JSON in pos_integrations.config - real,
// unencrypted secrets sitting in the database. This is the single place
// that encrypts/decrypts them, so every one of the ~8 call sites that
// touch that column goes through the exact same, correct logic instead
// of each reimplementing it (and inevitably drifting or missing one).
//
// AES-256-GCM: authenticated encryption (tampering with the ciphertext
// is detected, not just silently decrypted wrong) - the standard,
// correct choice for this, not a home-grown scheme.
//
// Backward compatible on purpose: decryptConfig() recognizes the new
// { encrypted, iv, authTag } shape and decrypts it, but if it's handed
// an already-plain object (every row written before this existed), it
// just returns that object unchanged. This means existing integrations
// keep working the instant this code deploys - no data migration has to
// run first, and nothing breaks for a business who configured their
// payment gateway last week. New writes always encrypt; a one-time
// backfill to re-save existing rows (which naturally re-encrypts them
// the next time they're touched via upsertPaymentIntegration) closes
// the gap for old rows over time, or can be done as a deliberate script
// once this is confirmed working - not bundled into this change, since
// a bulk rewrite of production credential rows isn't something to run
// unverified.
// =========================================================================

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const keyHex = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!keyHex) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY is not set - generate one with `openssl rand -hex 32` and add it to your environment before storing any credentials.');
  }
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY must be a 32-byte (64 hex character) key - generate one with `openssl rand -hex 32`.');
  }
  return key;
}

// Encrypts a config object (whatever shape - Tap's { secretKey }, Zoho's
// { access_token, refresh_token }, etc.) into a JSON-safe wrapper that
// still fits in the same jsonb column, no schema/column-type change
// required.
function encryptConfig(configObject) {
  const key = getKey();
  const iv = crypto.randomBytes(12); // 96-bit IV, the GCM standard
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = JSON.stringify(configObject ?? {});
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

// Decrypts back to the original config object. Passing through
// unchanged when the input isn't in the encrypted shape is what keeps
// every existing, not-yet-re-encrypted row readable without a forced
// migration - see the file header.
function decryptConfig(stored) {
  if (!stored || typeof stored !== 'object') return stored;
  if (!stored.encrypted || !stored.iv || !stored.authTag) return stored; // legacy plaintext row

  try {
    const key = getKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(stored.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(stored.authTag, 'base64'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(stored.encrypted, 'base64')), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch (err) {
    // A failed decrypt (wrong key, corrupted data, tampering caught by
    // the auth tag) must never silently fall back to something wrong -
    // surface it loudly instead of quietly returning garbage credentials.
    throw new Error(`Could not decrypt stored credentials: ${err.message}`);
  }
}

// Same AES-256-GCM primitive as encryptConfig/decryptConfig, but for a
// single string value stored in its own text column - Zoho Books' OAuth
// tokens (access_token, refresh_token) aren't a JSON config blob, just
// plain text columns, so this stores the {encrypted, iv, authTag}
// triple as one JSON string rather than a jsonb object. No schema
// change needed - the column stays `text`, its content just changes
// shape.
function encryptString(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(String(plaintext ?? ''), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return JSON.stringify({
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  });
}

// Same legacy-passthrough rule as decryptConfig: a stored value that
// isn't valid JSON in the encrypted shape (i.e. every token saved
// before this existed) is returned exactly as stored, so nothing breaks
// the moment this deploys.
function decryptString(stored) {
  if (!stored || typeof stored !== 'string') return stored;
  let parsed;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return stored; // legacy plaintext row - not JSON at all
  }
  if (!parsed?.encrypted || !parsed?.iv || !parsed?.authTag) return stored;

  try {
    const key = getKey();
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(parsed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(parsed.authTag, 'base64'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(parsed.encrypted, 'base64')), decipher.final()]);
    return decrypted.toString('utf8');
  } catch (err) {
    throw new Error(`Could not decrypt stored token: ${err.message}`);
  }
}

module.exports = { encryptConfig, decryptConfig, encryptString, decryptString };

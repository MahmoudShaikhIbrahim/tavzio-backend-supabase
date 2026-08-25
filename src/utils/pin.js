const crypto = require('crypto');

// scrypt is built into Node itself (no bcrypt/argon2 dependency needed)
// and is a real, memory-hard, industry-recommended choice for this -
// see Node's own crypto docs. Format stored: 'saltHex:hashHex'.
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPin(pin, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  // Constant-time comparison - a plain === here would let response-time
  // differences leak how many leading hex characters matched, a real
  // (if narrow) side-channel for a 4-6 digit keyspace this small.
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(candidate, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { hashPin, verifyPin };

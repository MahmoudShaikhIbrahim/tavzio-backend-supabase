// The single source of truth for "how far along is this member, and what
// do they get" - shared between the tap check-in flow (publicController)
// and manual staff adjustments (loyaltyController), so the two paths
// can never silently disagree with each other.
//
// Two independent choices define a program, not one fixed type:
//   earn_method: 'visit' (tap-based) | 'spend' (staff enters amount)
//   structure:   'threshold' (one reward, redeemed once, then resets)
//              | 'tiered' (ongoing status, applies automatically forever)
//   use_points: visit+threshold/tiered only - measure in points
//               (visits × pointsPerVisit) instead of raw visit count.

// The number actually being measured against a threshold or tier list.
function getMeasure(program, membership) {
  if (program.earn_method === 'spend') return Number(membership.total_spend);
  if (program.use_points) return Number(membership.points);
  return Number(membership.visits);
}

// Threshold structure only - is a reward ready to claim right now.
function isThresholdReady(program, membership) {
  if (program.structure !== 'threshold') return false;
  const cfg = program.config || {};
  const measure = getMeasure(program, membership);

  if (program.earn_method === 'spend') {
    const threshold = cfg.thresholdAmount || 500;
    return measure > 0 && measure >= threshold;
  }
  if (program.use_points) {
    const threshold = cfg.redeemThreshold || 100;
    return measure >= threshold;
  }
  const required = cfg.visitsRequired || 10;
  return measure > 0 && measure % required === 0;
}

// Tiered structure only - which tier (if any) this member currently
// qualifies for, with that tier's own reward attached (each tier can have
// a different discount/perk - a Gold member's reward isn't Silver's).
function getCurrentTier(program, membership) {
  if (program.structure !== 'tiered') return null;
  const cfg = program.config || {};
  const measure = getMeasure(program, membership);
  const tiers = [...(cfg.tiers || [])].sort((a, b) => b.threshold - a.threshold);
  return tiers.find((t) => measure >= t.threshold) || null;
}

module.exports = { getMeasure, isThresholdReady, getCurrentTier };

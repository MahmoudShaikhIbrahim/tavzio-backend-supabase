// =========================================================================
// Fresha connector
// =========================================================================
// HONEST STATE: unlike the other four adapters in this folder, there is no
// confirmed public developer API for Fresha. Research found:
//   - No public developer portal or API reference (Foodics, Square, Zenoti,
//     and Loyverse all have one; Fresha does not).
//   - Fresha's own customer community has a thread literally titled
//     "Give us API integration access" - a customer ASKING for this,
//     which strongly suggests it isn't broadly available.
//   - partners.fresha.com is a BUSINESS/marketplace partnership (getting a
//     salon listed and bookable on Fresha), not a TECHNICAL/developer
//     partnership for pushing data in from an outside system - a
//     different thing entirely.
//   - The only confirmed integration paths are Zapier (no-code, limited)
//     and read-only reporting/BI data connectors (Snowflake-based),
//     neither of which can create a new booking from Tavzio.
//
// This function deliberately does NOT guess at a request format the way
// the Foodics adapter's TODO does - there's no official documentation to
// base a guess on, and shipping a fabricated request would be actively
// misleading. If a business genuinely needs this, the real next step is
// contacting Fresha's business development team directly to ask whether
// a private/enterprise API exists outside their public docs - that's a
// business conversation, not something resolvable in code.
// =========================================================================

async function pushBooking() {
  return {
    success: false,
    error: 'Fresha has no confirmed public API for creating bookings. Contact Fresha directly to check for private/partner API access before enabling this integration.',
  };
}

module.exports = { pushBooking };

# Tavzio Backend — Supabase Edition

> **Confirmed for this project (checked in Project Settings → JWT Signing
> Keys):** this project uses asymmetric ECC signing keys, not the legacy
> shared HS256 secret. Admin tap-login therefore issues sessions via
> Supabase's own `generateLink`+`verifyOtp` flow (2 Auth API calls,
> server-side, never emailed to anyone) rather than self-signing — that's
> what actually works correctly under this project's configuration. See
> "Admin cards" below.

## Setup

1. Create/open your Supabase project (can be the same project as Scripzio, or
   a new one — recommend a **separate project**, since Scripzio and Tavzio
   are unrelated tenants of data, and mixing them makes RLS policies and
   backups harder to reason about).
2. Run the migration: paste `supabase/migrations/0001_init.sql` into the
   Supabase SQL Editor and execute it (or use `supabase db push` if you have
   the CLI linked to this project).
3. Copy `.env.example` to `.env` and fill in the three keys from
   Project Settings → API: `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`.
4. `npm install && npm run dev`

## What changed from the MongoDB version

- **Auth is now Supabase Auth**, not custom JWT + bcrypt. Register/login
  routes are thin wrappers around `supabase.auth.signUp` /
  `signInWithPassword`. Less code for you to maintain and secure.
- **Tenant isolation moved into the database.** Every table has Row Level
  Security policies keyed off two helper SQL functions
  (`current_role_name()`, `current_business_id()`) that read the caller's
  `profiles` row. A `business_owner` querying `cards` or `events` physically
  cannot get another business's rows back — it's not just an `if` check in
  Express anymore.
- **`req.supabase` vs `supabaseAdmin`**: controllers mostly use
  `req.supabase`, a client scoped to the logged-in user's token, so RLS
  applies automatically. `supabaseAdmin` (service role, bypasses RLS) is used
  only in two places on purpose: (1) signup, because creating a business and
  linking a brand-new profile to it is one atomic step that has to happen
  before any tenant policy could apply, and (2) the public NFC tap/click
  endpoints, since anonymous customers have no session for RLS to key off of.
- **Analytics went from Mongo aggregation pipelines to Postgres functions**
  (`get_business_summary`, `get_card_breakdown` in the migration file),
  called via `req.supabase.rpc(...)`. They run as `SECURITY INVOKER` (the
  default), meaning they execute with the caller's own RLS permissions —
  so even the analytics shortcuts can't leak cross-tenant data.
- **Cards, Events keep the same shape** as before, just as Postgres tables
  instead of Mongoose schemas. `events.id` is a `bigint identity` (fast,
  sequential) rather than a UUID, since it's high-volume and never
  referenced externally.

## Loyalty programs

One optional program per business, fully toggleable and reconfigurable —
same "add/remove/adjust per business" pattern as the landing page buttons,
just with real state instead of a static link.

**Four types, no POS integration needed:**
- `punch_card` — visit N times, get a reward
- `points` — earn points per visit, redeem at a threshold
- `tiered` — visit-count-based status levels (e.g. Silver at 5 visits, Gold
  at 20), ongoing perks rather than one-time redemptions
- `spend` — reward at a spend threshold; since there's no POS feed, staff
  enter the amount manually via the dashboard adjust endpoint

**How a check-in actually works:**
1. Customer taps the NFC card → `resolveCardTap` logs the tap and hands back
   a `tapEventId` alongside the redirect.
2. Landing page loads, customer enters their phone number, frontend calls
   `POST /business/:slug/loyalty/checkin` with `{ phone, tapEventId }`.
3. The backend verifies that event is a real, recent (`30 min` window)
   `nfc_tap` for that business before crediting anything — a customer
   reloading the public page from home has no valid tap token, so they
   can't self-credit visits.
4. A unique index on `loyalty_transactions.source_event_id` makes double-
   crediting the same tap impossible even under a retried/duplicate request.

Staff can always manually adjust or redeem from the dashboard
(`/loyalty/members/:membershipId/adjust` and `/redeem`) — useful for
goodwill stamps, correcting mistakes, or entering a spend amount.

Customers are stored by phone number in one shared `customers` table (a
person visiting 3 different Tavzio businesses is one row), but a business
can only ever see customers who have a membership — i.e. have actually
checked in — at their own business, enforced by RLS.

**Repeat visits are now automatic on a recognized device.** The frontend
remembers a customer's phone locally (their browser, not the card - cards
can't identify anyone, see `LoyaltyWidget.tsx` for the full reasoning). On
every fresh tap where that memory exists, the frontend calls the real
check-in endpoint automatically, silently — no retyping. If someone clears
their browser or switches phones, retyping their number once fully
reconnects them to their existing progress (nothing is ever stored only in
the browser) — it's a convenience layer, not where the data lives.

**Cooldown, owner-configurable per program** (`config.cooldown`): `none`,
`daily`, `weekly`, or a `custom` number of hours. This exists specifically
*because* auto-checkin made it necessary — without a cooldown, someone
tapping the same card five times in ten seconds would earn five credits.
Before crediting, `loyaltyCheckin` checks when this membership last earned
anything; if inside the window, it returns the current (unchanged) status
with `alreadyCounted: true` instead of crediting again. **Never applies to
`spend`** — that's entered manually by staff per visit, not something a
customer could fake by re-tapping.

## Migration 0009 — the big one

Everything below was added in one pass, per an extensive, explicitly
approved scope. All of it needs `0009_paybill_customization_and_selfservice.sql`
run (after `0001`-`0008`).

**Self-service feature toggles, now for owner AND staff too** - not just
super_admin. `PATCH /businesses/:businessId/features` now accepts
`business_owner`/`staff` as well; RLS was updated independently
(`businesses` UPDATE policy) so this isn't just a route-level check.
super_admin keeps identical access, for help/override - not the only place
it lives anymore.

**Admin cards removed entirely - website login only for owner/staff now.**
Nothing was deleted from the database or backend logic (the tap-login code
path for `cards.linked_user_id` still exists, quietly, in case this is
ever revisited) - just every UI path for issuing one. **A real lockout bug
was caught and fixed as part of this**: `accessMethods.website` used to
default to `false`, which combined with admin cards disappearing would
have left every new business's owner with zero way to ever log in. Fixed
at the database level (both the default for new businesses and a backfill
for existing ones) so this can't happen to anyone.

**Card creation locked to super_admin only** (RLS enforces this, not just
routing) - owner/staff keep rename and status changes on existing cards.
No DELETE route or RLS policy exists for cards at all anymore - "Disable"
is the only retirement path, deliberately, since a truly deleted card
means an orphaned physical chip with no way back except reprogramming.

**Pay Bill / split payments**, built on Tap Payments (Option A - each
business connects their own account, Tavzio never touches funds - see the
research and reasoning earlier in this project's history if you have
access to it, or ask the person who commissioned this build). Customers
pick specific items to pay (covering their own, or someone else's - never
auto-attributed), or pay the full remaining balance. `order_items.paid`
tracks settlement; `payments` records each transaction. **Payment
credentials are owner-only, genuinely enforced at the RLS level** - not
even super_admin can read the raw Tap secret key, only a sanitized
connected/not-connected status (see migration 0009's RLS section for
exactly how this differs from ordering/booking POS credentials, which
stay super_admin-only).

**Generic ("Custom") POS connector** - `utils/customPosAdapter.js` - a
no-code translator for simple POS APIs: endpoint URL, auth header, a
fill-in-the-blank JSON body template. Configured entirely from super
admin, no file, no deploy. Complex POS systems (multi-step auth,
non-JSON) still need a real one-time adapter file.

**Notification sounds**, 4 fully independent events (`callWaiter`,
`requestBill`, `newOrder`, `newBooking`, `paymentConfirmed`) -
`businesses.notification_settings`. Each has its own on/off, preset
choice, or uploaded custom sound (same Storage bucket as logo/menu
photos). Presets are synthesized via the Web Audio API on the frontend,
not bundled audio files - genuinely playable with zero assets to host.

**Custom buttons** - `custom_buttons` table - genuinely new landing-page
buttons beyond the fixed 7, with their own label/icon/link. Full parity:
owner, staff, and super_admin can all manage these.

**Menu item photos** - wired up the `image_url` column that existed but
was never connected to an upload flow. Same Storage pattern as everything
else.

**CSV/PDF exports** for orders, bookings, and payments -
`exportController.js`, uses `pdfkit` (added to `package.json`). For
tax/bookkeeping purposes specifically - the actual VAT compliance is the
business's own responsibility (or their POS/accountant's), this just
makes the underlying data something an accountant can actually use.

## Access methods — card, website, or both (per business)

Owners/staff were originally tap-only, with password login blocked
entirely for those roles (see the "known open item" fix below — that
fix stays intact). This was later revised: some businesses want the
option of website login instead of, or alongside, a physical card. The
resolution is a third per-business toggle, same one-tier
super_admin-only model as everything else:

`businesses.features.accessMethods = { card: boolean, website: boolean }`
— both can be true at once. Enforced in two places:

- **`POST /api/auth/login`**: `super_admin` always allowed (not tied to
  any business). Owner/staff allowed only if their business's
  `accessMethods.website` is true — otherwise the exact same 403 as
  before.
- **`resolveCardTap`**: checks `accessMethods.card` before letting an
  admin card's tap actually log someone in — so a business switched to
  website-only can't have a lingering card silently keep working.

**Staff invites changed as a result**: `inviteStaff` now uses Supabase's
real `inviteUserByEmail` flow instead of generating a random,
never-shared password. This sends an actual email letting the staff
member set their own password. If their business is card-only, they can
just ignore that email and use their card — nothing breaks. If website
access is (or later becomes) enabled, the same account already has a
real, working password, with nothing extra to set up.

**One thing not built yet**: there's no "forgot password" flow wired up
on the frontend. Worth adding before relying on website login for real
businesses, since people do forget passwords — Supabase's
`resetPasswordForEmail` would be the mechanism, just not connected to a
page yet.

## Admin cards — tap-to-login for owner AND staff

Any number of admin cards per business, each linked to one specific
person's account (`cards.linked_user_id`) — typically one for the owner and
one for a staff member, though a business can skip either if only one
person needs dashboard access. Because each card is tied to an individual,
not just "the business," the owner's card and a staff card work completely
independently — nothing about one affects the other.

**By default, every tap logs in instantly** — a real Supabase session is
issued via `generateLink`+`verifyOtp` (`issueSessionFor()` in
`publicController.js`), generated and exchanged server-side in the same
request, never emailed to anyone. No waiting, no email step by default.

This project's JWT Signing Keys are asymmetric (ECC) — confirmed in Project
Settings → JWT Signing Keys, "Current Key" shows `ECC (P-256)`. That's why
sessions are issued this way rather than self-signed: only Supabase's own
Auth server holds the private key under asymmetric signing, so a valid
token can only come from actually calling Supabase, not from forging one
locally. (`utils/tapSession.js` contains the self-signing approach that
would apply if this project ever used the legacy shared-secret mode
instead — not used currently, kept for reference.)

**Adding a staff member**: `POST /businesses/:businessId/staff` (owner
only) creates their account; `POST /businesses/:businessId/staff/:userId/card`
issues their tap card. Issuing/reissuing cards is `super_admin`-only,
matching how the physical NFC chips actually get programmed — in person, by
you.

**Lost a card**: either the owner or staff can disable ANY admin card the
moment they notice one's missing — the existing generic
`PATCH /businesses/:businessId/cards/:cardId` route with `{ status:
"disabled" }` is open to any authenticated member of that business, no
special role needed. Getting a working replacement is then a
"contact the platform operator" step, on purpose — that's the
`super_admin`-only reissue endpoint above. A database constraint
(`idx_cards_one_active_per_user`) makes it physically impossible for two
cards to be active for the same person at once.

**No refresh tokens on tap sessions, by design**: re-authentication is just
tapping the card again — there's no silent-refresh flow to secure or reason
about.

## The door left open for later

Two flags, both **off by default** — the current behavior above is what you
get with default settings:

- `REQUIRE_DEVICE_CONFIRMATION=true` — an unrecognized device gets a
  confirm-by-email step (open the link on that same device) before it's
  granted access, and is remembered after that. All the supporting code and
  tables already exist (`trusted_devices`, `pending_device_confirmations`,
  `GET /api/auth/confirm-device/:pendingId`) — flipping this flag is the
  only change needed, nothing to rebuild.
- `ENABLE_ADMIN_LOGIN_ALERTS=true` — sends a "your card was just used" email
  on every admin login.

Both require SMTP credentials in `.env` (any provider — Zoho, Gmail,
Resend, etc.) to actually send mail.

Two other protections stay on regardless of these flags, since they're free
(no added friction) and closer to always-worth-having:
- **Atomic reissue** — disabling the old card and creating the new one
  happens inside one Postgres function (`reissue_admin_card`), not two
  separate steps, so there's no crash-in-between window.
- **Auto session revocation** — every reissue or staff deactivation rotates
  that person's account password to a random value nobody uses
  (`utils/revokeSessions.js`), closing the "already logged in somewhere" gap
  immediately rather than waiting for a session to expire naturally.

## Real-time dashboard

Every GET/RPC endpoint always reads live from Postgres — there's no caching
layer anywhere in this backend, so a manual refresh always shows the true
current state. That half is already covered by simply not having added a
cache.

For "never has to refresh while the page is open," the `events`,
`loyalty_memberships`, `loyalty_transactions`, and `cards` tables are now
added to Supabase's Realtime publication (migration `0003`). The frontend
subscribes directly using the logged-in user's own Supabase client — no
custom websocket code needed on this backend at all:

```js
supabase
  .channel(`business-${businessId}`)
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'events', filter: `business_id=eq.${businessId}` },
    (payload) => { /* bump tap counters, append to activity feed, etc. */ }
  )
  .subscribe();
```

Realtime enforces the same RLS policies as everything else — a
business_owner's subscription only ever receives their own business's rows,
automatically. One setup step you'll need to do once in the Supabase
dashboard: confirm Realtime is enabled for these four tables under
Database → Replication (the migration adds them to the publication, but
double-check the toggle in the dashboard matches).

## Storage (business logos/covers)

One public Supabase Storage bucket, `business-assets`. Public read (these
images appear on public landing pages), but writes are locked to the
business that owns the folder — same tenant-isolation pattern as every
table, just applied to file storage. Path convention:
`{businessId}/logo.{ext}` and `{businessId}/cover.{ext}` — fixed filenames
per type, so re-uploading overwrites cleanly instead of piling up orphaned
files. The frontend uploads directly to Supabase (not through this
backend) using the same authenticated session as everything else — see the
frontend's `src/lib/supabaseClient.ts`.

## Returning-visitor analytics

Every event write captures one anonymous signal beyond device type: a
visitor id, sent by the frontend as the `X-Visitor-Id` header and stored
in `events.session_id`. This is a random id the frontend generates and
keeps in that browser's `localStorage` — never a phone number, name, or
anything tied to identity. It's what powers the new-vs-returning-visitor
split in `get_business_summary`, entirely separate from the (opt-in,
phone-number-based) loyalty program.

**Country/city geolocation was built, then removed.** IP-based location
only reflects the network connection, not where a customer is actually
from — for a UAE-only customer base, nearly every tap would've just shown
"UAE" regardless of whether the customer was a lifelong local or a tourist
on a UAE SIM/wifi, which wasn't a useful distinction. `geoip-lite` and
`src/utils/geoLocate.js` were removed rather than left as unused dead
code; `events.country`/`events.city` columns still exist in the schema
(harmless to leave, no destructive migration needed) but are no longer
populated. If you ever want real tourist-vs-local data, that needs to come
from asking the customer directly (e.g. a simple toggle at checkout), not
inferred from network data.

`app.set('trust proxy', true)` in `server.js` is still needed and was kept
— it matters for accurate per-IP rate limiting, independent of the
geolocation feature that used to also rely on it.

## Things to decide before going live

1. **Email confirmation**: Supabase Auth defaults to requiring email
   confirmation before login. Decide if that's the flow you want for
   business owners signing up, or if you'd rather disable it in
   Authentication → Settings for a faster onboarding flow (you program their
   card in person anyway, so friction-free signup may matter more here than
   for a typical SaaS).
2. **Super admin seeding**: there's no route to create a `super_admin` —
   sign up normally, then manually update that one row's `role` in the
   `profiles` table via the Supabase dashboard.
3. **Staff role permissions**: staff and business_owner currently have
   identical RLS access to business data (cards, events, loyalty). The one
   thing already restricted to owner-only is managing staff accounts
   (invite/deactivate); issuing/reissuing admin cards is `super_admin`-only.
   If you want staff limited further (e.g. can't change business settings,
   only manage cards/loyalty), that's additional RLS policies per table, not
   a rewrite.
4. ~~**Known open item**: `POST /api/auth/login` unprotected for any
   account~~ — **fixed, then revised**. `login()` in `authController.js`
   originally blocked every owner/staff account outright. That's since
   been loosened into the `accessMethods.website` per-business toggle
   described above — still closed by default for any business that
   hasn't been explicitly granted it, just no longer a blanket rule for
   every business regardless of what they want.
5. **Run all nine migrations in order**: `0001` through `0009`, each one
   before the next. `0004` adds Storage + analytics; `0005` removes the
   country breakdown that `0004` had added; `0006` adds the ordering
   system and POS integration architecture; `0007` adds the full feature
   toggle system and booking; `0008` adds the access-methods toggle;
   `0009` adds payments, notification sounds, custom buttons, and removes
   admin cards entirely (see the dedicated section above for the full scope).

## Ordering + POS integration

**Entitlement, not self-service**: every `features.ordering.*` flag
(`menuView`, `submission`, `posIntegration`, `callWaiter`, `requestBill`)
is `super_admin`-only (`PATCH /businesses/:businessId/features`) — a
business can't turn any of it on for itself, matching how you actually
onboard clients in person. Once enabled, the owner/staff manage their own
menu day-to-day (categories/items — that's normal catalog upkeep, not an
entitlement).

**Menu viewing and order submission are independent toggles, on purpose**:
a business can have `menuView` on with `submission` off — a genuinely
read-only menu (`getPublicMenu` returns `submissionEnabled: false`, and the
frontend renders items with no add-to-cart, no cart bar, nothing to
submit). Prices and descriptions still show either way; only the ability
to act on them depends on `submission`. This also means browsing a
read-only menu never needs a fresh tap-token check — only the actual
`submitOrder` call does, since that's the only thing that could be faked
remotely.

**The order flow**: customer taps → browses `/api/public/business/:slug/menu`
→ builds a cart → `POST /api/public/business/:slug/orders`. Gated by the
exact same tap-verification pattern as loyalty check-in (`TAP_TOKEN_VALID_MINUTES`
window) — the card is derived from the tap event itself, not a separately
supplied card id, so there's nothing extra for a customer to fake. Prices
are always looked up server-side from `menu_items`, never trusted from the
client.

**Tavzio's own order screen works for every business, no dependency on
anything external.** `orders`/`order_items` are in the Realtime publication,
same mechanism as everything else that updates without a refresh — a new
order appears on the owner/staff dashboard's Orders tab the instant it's
placed.

**POS integration is optional, on top of that.** `pos_integrations` is one
row per business, `super_admin`-only (RLS blocks owner/staff from the raw
table entirely — they get a sanitized status-only view via
`GET .../pos-integration/status`, no credentials exposed). When enabled,
`submitOrder` also calls `utils/posDispatcher.js`, which routes to the
right adapter by provider name — currently just `utils/foodicsAdapter.js`.
Adding a second POS later means adding one more adapter file, not touching
the dispatcher or the order flow.

**Foodics was chosen deliberately**, not arbitrarily — it's the most
consistently recommended POS across UAE/GCC restaurant sources, has
built-in VAT/FTA compliance, and (critically) has a real, documented
public API pattern for exactly this: external orders appearing directly
in the merchant's own cashier screen, not a separate display. That said —
**one honest gap, not a placeholder pretending to be finished**: the exact
private API request format inside `foodicsAdapter.js` isn't filled in.
Foodics gates their full developer reference behind a business actually
having their "Advanced" plan or a purchased API license — something I
can't fabricate without that access. Everything up to that one HTTP call
(the calling convention, error handling, status tracking, how
`orderController.js` and `submitOrder` use it) is real and complete; only
the TODO-marked request body inside `pushOrder()` needs filling in once
real credentials exist.

**Tax note, since it came up**: the POS (Foodics or otherwise) is what
actually handles FTA-compliant tax invoicing — that's its job already.
This integration doesn't create tax compliance; it removes the manual
step of a staff member re-typing a Tavzio order into the POS by hand,
which is where errors and missed entries happen. Without integration,
staff can still manually re-enter an order — slower, but not a compliance
blocker either way.

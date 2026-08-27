require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { errorHandler, notFound } = require('./middleware/errorHandler');

const authRoutes = require('./routes/authRoutes');
const businessRoutes = require('./routes/businessRoutes');
const publicRoutes = require('./routes/publicRoutes');
const messagesRoutes = require('./routes/messagesRoutes');
const publicContractRoutes = require('./routes/publicContractRoutes');
const superAdminDigitalCardRoutes = require('./routes/superAdminDigitalCardRoutes');
const publicCardRoutes = require('./routes/publicCardRoutes');
const stripeRoutes = require('./routes/stripeRoutes');
const leadRoutes = require('./routes/leadRoutes');
const deliverectRoutes = require('./routes/deliverectRoutes');
const contractsAdminRoutes = require('./routes/contractsAdminRoutes');
const demoAdminRoutes = require('./routes/demoAdminRoutes');

const app = express();

// Railway (and most PaaS hosts) sit behind a proxy - without this, every
// request would appear to come from Railway's own internal address,
// which breaks per-IP rate limiting (everyone would share one bucket).
// Railway sits exactly one proxy hop in front of this app. Trusting
// depth 1 (rather than `true`, which trusts any number of hops) means
// Express only reads the client IP from that one known hop, so a
// request can't spoof its way past IP-based rate limiting by faking
// extra proxy headers.
app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin: (process.env.CLIENT_URL || '').split(',').filter(Boolean),
    credentials: true,
  })
);
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Real fix, not just a bigger number: /api/auth and /api/businesses used
// to share ONE 300-request budget per IP. That's how a heavy dashboard
// session (lots of business API traffic - normal, expected usage) could
// exhaust the SAME budget login itself depends on, locking someone out
// of their own account with no relation to actual login attempts.
// Separate budgets now, so business API traffic can never starve out
// login again. 600 for business traffic reflects what a real multi-page
// dashboard with 15s notification polling plus realtime actually uses
// over 15 minutes, not the original number sized before most of this
// app's current page count existed.
const authApiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 600 });
const publicLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/api/auth', authApiLimiter, authRoutes);
app.use('/api/businesses', apiLimiter, businessRoutes);
app.use('/api/public', publicLimiter, publicRoutes);
app.use('/api/messages', apiLimiter, messagesRoutes);
app.use('/api/public/contracts', publicLimiter, publicContractRoutes);
app.use('/api/super-admin/digital-cards', apiLimiter, superAdminDigitalCardRoutes);
app.use('/api/public/cards', publicLimiter, publicCardRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/leads', apiLimiter, leadRoutes);
app.use('/api/deliverect', deliverectRoutes);
app.use('/api/organizations', apiLimiter, require('./routes/organizationRoutes'));
app.use('/api/contracts', apiLimiter, contractsAdminRoutes);
app.use('/api/admin/demo', apiLimiter, demoAdminRoutes);
app.get('/api/zoho-books/callback', require('./controllers/zohoBooksController').oauthCallback);

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Tavzio API (Supabase) running on port ${PORT}`));

// Payment reconciliation - recovers a payment whose customer or staff
// member never made it back from the gateway's redirect (locked phone,
// closed tab, dropped connection) but whose charge genuinely succeeded
// on the gateway's side. Runs every 2 minutes; each run only touches
// payments stuck 3+ minutes, so a normal in-progress checkout is never
// mistaken for an abandoned one. Covers the remaining redirect-payment
// paths: paying an existing bill, paying for a new order, and a booking
// deposit. The fourth (staff-initiated card_online POS sale) was
// removed along with that flow once Send to Kitchen and Payment became
// separate actions - a physical POS terminal settling via redirect to a
// hosted gateway page never made sense for a staff-operated counter.
const { reconcilePendingBillPayments, reconcilePendingOrderPayments } = require('./controllers/publicController');
const { reconcilePendingBookingPayments } = require('./controllers/bookingPublicController');
const { checkContractBillingAndExpiryNotifications } = require('./utils/contractBillingCheck');
setInterval(() => {
  reconcilePendingBillPayments().catch((err) => console.error('Bill payment reconciliation run failed:', err.message));
  reconcilePendingOrderPayments().catch((err) => console.error('Order payment reconciliation run failed:', err.message));
  reconcilePendingBookingPayments().catch((err) => console.error('Booking payment reconciliation run failed:', err.message));
}, 2 * 60 * 1000);

// Real, once-a-day check for upcoming contract billing and expiry -
// a day-level countdown doesn't need minute-level polling like the
// payment reconciliation jobs above. Also runs once immediately on
// startup, so a freshly-deployed server doesn't wait a full day before
// its first real check.
setInterval(() => {
  checkContractBillingAndExpiryNotifications().catch((err) => console.error('Contract billing/expiry check failed:', err.message));
}, 24 * 60 * 60 * 1000);
checkContractBillingAndExpiryNotifications().catch((err) => console.error('Contract billing/expiry check failed:', err.message));

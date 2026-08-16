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
const ziinaRoutes = require('./routes/ziinaRoutes');
const publicContractRoutes = require('./routes/publicContractRoutes');
const stripeRoutes = require('./routes/stripeRoutes');
const leadRoutes = require('./routes/leadRoutes');
const deliverectRoutes = require('./routes/deliverectRoutes');

const app = express();

// Railway (and most PaaS hosts) sit behind a proxy - without this, every
// request would appear to come from Railway's own internal address,
// which breaks per-IP rate limiting (everyone would share one bucket).
app.set('trust proxy', true);

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
app.use('/api/ziina', apiLimiter, ziinaRoutes);
app.use('/api/public/contracts', publicLimiter, publicContractRoutes);
app.use('/api/stripe', stripeRoutes);
app.use('/api/leads', apiLimiter, leadRoutes);
app.use('/api/deliverect', deliverectRoutes);
app.use('/api/organizations', apiLimiter, require('./routes/organizationRoutes'));
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
// mistaken for an abandoned one. Covers all three redirect-payment
// paths: paying an existing bill, paying for a new order, and a
// staff-initiated card_online POS sale.
const { reconcilePendingBillPayments, reconcilePendingOrderPayments } = require('./controllers/publicController');
const { reconcilePendingPosCardPayments } = require('./controllers/orderController');
setInterval(() => {
  reconcilePendingBillPayments().catch((err) => console.error('Bill payment reconciliation run failed:', err.message));
  reconcilePendingOrderPayments().catch((err) => console.error('Order payment reconciliation run failed:', err.message));
  reconcilePendingPosCardPayments().catch((err) => console.error('POS card payment reconciliation run failed:', err.message));
}, 2 * 60 * 1000);

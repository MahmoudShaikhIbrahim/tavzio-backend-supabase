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
app.use(express.json());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
const publicLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.use('/api/auth', apiLimiter, authRoutes);
app.use('/api/businesses', apiLimiter, businessRoutes);
app.use('/api/public', publicLimiter, publicRoutes);
app.use('/api/messages', apiLimiter, messagesRoutes);

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Tavzio API (Supabase) running on port ${PORT}`));

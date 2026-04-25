/**
 * BYOV Sync API Server
 *
 * Zero-knowledge vault sync: this server stores only encrypted blobs.
 * It has no ability to decrypt vault data.
 *
 * Routes:
 *   POST   /auth/signup
 *   POST   /auth/login
 *   GET    /vault/header
 *   PUT    /vault/header
 *   GET    /sync?since=version_…
 *   POST   /items
 *   PUT    /items/:id
 *   DELETE /items/:id
 *   GET    /health
 */

'use strict';

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

const authRouter  = require('./routes/auth');
const syncRouter  = require('./routes/sync');
const itemsRouter = require('./routes/items');
const vaultRouter = require('./routes/vault');
const { authMiddleware } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Security middleware ──────────────────────────────────────────────────────

app.use(helmet());

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g., server-to-server) in development
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin "${origin}" not allowed.`));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '2mb' })); // vault blobs can be a few hundred KB

// Global rate limiter (generous – the real protection is per-route)
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
}));

// ─── Routes ───────────────────────────────────────────────────────────────────

// Health check (unauthenticated)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth routes (signup, login) – unauthenticated
app.use('/auth', authRouter);

// All other routes require a valid JWT
app.use(authMiddleware);
app.use('/vault', vaultRouter);
app.use('/sync',  syncRouter);
app.use('/items', itemsRouter);

// ─── Error handler ────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  const message = process.env.NODE_ENV === 'production'
    ? (status < 500 ? err.message : 'Internal server error')
    : err.message;
  res.status(status).json({ error: message });
});

// ─── Start ────────────────────────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[BYOV API] Server running on port ${PORT} (${process.env.NODE_ENV || 'development'})`);
  });
}

module.exports = app; // For testing

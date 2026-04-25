/**
 * Auth routes
 *
 * POST /auth/signup – creates a new Supabase user account
 * POST /auth/login  – authenticates and returns a JWT
 *
 * Note: Actual vault encryption is handled entirely client-side.
 * The server only manages authentication state; it never sees master passwords.
 */

'use strict';

const express    = require('express');
const rateLimit  = require('express-rate-limit');
const { getSupabase } = require('../db/client');

const router = express.Router();

// Stricter rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many authentication attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// POST /auth/signup
router.post('/signup', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required.' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const supabase = getSupabase();
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // auto-confirm for now; set to false for email verification
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(201).json({
      user_id: data.user.id,
      email:   data.user.email,
      message: 'Account created. You can now log in.',
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/login
router.post('/login', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required.' });
    }

    const supabase = getSupabase();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      // Use a generic message to avoid leaking user enumeration info
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    return res.json({
      access_token:  data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in:    data.session.expires_in,
      user_id:       data.user.id,
      email:         data.user.email,
    });
  } catch (err) {
    next(err);
  }
});

// POST /auth/refresh
router.post('/refresh', authLimiter, async (req, res, next) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) {
      return res.status(400).json({ error: 'refresh_token is required.' });
    }

    const supabase = getSupabase();
    const { data, error } = await supabase.auth.refreshSession({ refresh_token });

    if (error) {
      return res.status(401).json({ error: 'Invalid or expired refresh token.' });
    }

    return res.json({
      access_token:  data.session.access_token,
      refresh_token: data.session.refresh_token,
      expires_in:    data.session.expires_in,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

/**
 * Authentication middleware
 *
 * Verifies the Supabase JWT in the Authorization header.
 * Attaches req.user = { id, email } to the request.
 */

'use strict';

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

/**
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header.' });
  }

  const token = header.slice(7);
  if (!JWT_SECRET) {
    // In development without a real Supabase JWT secret, decode without verification
    // to allow testing. Never do this in production.
    if (process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'development') {
      return res.status(500).json({ error: 'Server JWT secret not configured.' });
    }
    try {
      const decoded = jwt.decode(token);
      if (!decoded?.sub) return res.status(401).json({ error: 'Invalid token.' });
      req.user = { id: decoded.sub, email: decoded.email };
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid token.' });
    }
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    req.user = { id: decoded.sub, email: decoded.email };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

module.exports = { authMiddleware };

/**
 * Vault header routes
 *
 * GET  /vault/header         – load vault header for the authenticated user
 * PUT  /vault/header         – save/update vault header
 *
 * The header contains: format, salt, wrapped_vault_key, wrapped_vault_nonce.
 * The server cannot decrypt any of this data.
 */

'use strict';

const express = require('express');
const { query } = require('../db/client');

const router = express.Router();

// GET /vault/header
router.get('/header', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const result = await query(
      'SELECT * FROM vault_headers WHERE user_id = $1',
      [userId],
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ header: null });
    }
    return res.json({ header: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

// PUT /vault/header
router.put('/header', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const {
      format,
      salt,
      wrapped_vault_key,
      wrapped_vault_nonce,
      device_id,
      sync_token,
    } = req.body;

    // Validate required fields
    if (!salt || !wrapped_vault_key || !wrapped_vault_nonce) {
      return res.status(400).json({
        error: 'salt, wrapped_vault_key, and wrapped_vault_nonce are required.',
      });
    }

    const result = await query(
      `INSERT INTO vault_headers
         (user_id, format, salt, wrapped_vault_key, wrapped_vault_nonce, device_id, sync_token, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         format              = EXCLUDED.format,
         salt                = EXCLUDED.salt,
         wrapped_vault_key   = EXCLUDED.wrapped_vault_key,
         wrapped_vault_nonce = EXCLUDED.wrapped_vault_nonce,
         device_id           = EXCLUDED.device_id,
         sync_token          = EXCLUDED.sync_token,
         updated_at          = NOW()
       RETURNING *`,
      [userId, format || 'BYOV/1', salt, wrapped_vault_key, wrapped_vault_nonce, device_id, sync_token || 'version_0'],
    );

    return res.json({ header: result.rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

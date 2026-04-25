/**
 * Sync routes
 *
 * GET /sync?since=version_…  – pull all items changed since the given sync token
 *
 * The sync token is a timestamp-based version string: "version_{timestamp_ms}"
 * Items are returned as encrypted blobs; the server cannot decrypt them.
 */

'use strict';

const express = require('express');
const { query } = require('../db/client');
const { writeAuditLog } = require('./items');

const router = express.Router();

// GET /sync?since=version_0
router.get('/', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const since  = req.query.since || 'version_0';

    // Parse the sync token to a timestamp
    const sinceMs = parseToken(since);
    const sinceDate = new Date(sinceMs);

    let result;
    if (sinceMs === 0) {
      // Full sync – return all non-deleted items
      result = await query(
        `SELECT id, user_id, type, encrypted_payload, nonce, item_version,
                updated_at, device_id, deleted
         FROM vault_items
         WHERE user_id = $1
         ORDER BY updated_at ASC`,
        [userId],
      );
    } else {
      // Incremental sync – return items changed since the token
      result = await query(
        `SELECT id, user_id, type, encrypted_payload, nonce, item_version,
                updated_at, device_id, deleted
         FROM vault_items
         WHERE user_id = $1
           AND updated_at > $2
         ORDER BY updated_at ASC`,
        [userId, sinceDate],
      );
    }

    const syncToken = `version_${Date.now()}`;

    // Write audit log (no item content)
    await writeAuditLog({
      userId,
      action: 'sync',
      deviceId: req.headers['x-device-id'] || null,
      ipHash: hashIp(req.ip),
      userAgent: req.headers['user-agent'],
    }).catch(() => {}); // non-fatal

    return res.json({
      items:      result.rows,
      sync_token: syncToken,
      count:      result.rows.length,
    });
  } catch (err) {
    next(err);
  }
});

function parseToken(token) {
  if (!token || token === 'version_0') return 0;
  const m = token.match(/version_(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * Hashes an IP address with SHA-256 for privacy-preserving logging.
 * Requires the built-in 'crypto' module (Node.js >= 15).
 */
function hashIp(ip) {
  if (!ip) return null;
  try {
    const { createHash } = require('crypto');
    return createHash('sha256').update(ip).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

module.exports = router;

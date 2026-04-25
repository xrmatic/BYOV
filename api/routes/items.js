/**
 * Items routes
 *
 * POST   /items          – create or update a single encrypted vault item
 * PUT    /items/:id      – update a specific item
 * DELETE /items/:id      – soft-delete a specific item
 *
 * All item payloads are encrypted by the client before being sent.
 * The server stores and returns encrypted blobs only.
 */

'use strict';

const express = require('express');
const { query } = require('../db/client');

const router = express.Router();

// POST /items (upsert)
router.post('/', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const {
      id,
      type,
      encrypted_payload,
      nonce,
      item_version,
      updated_at,
      device_id,
    } = req.body;

    const validationError = validateItemFields({ type, encrypted_payload, nonce });
    if (validationError) return res.status(400).json({ error: validationError });

    const result = await upsertItem({
      id: id || undefined,
      userId,
      type,
      encrypted_payload,
      nonce,
      item_version: item_version || 1,
      device_id,
      updated_at,
    });

    await writeAuditLog({ userId, action: 'item_write', deviceId: device_id, itemId: result.id });

    return res.status(201).json({ item: result });
  } catch (err) {
    next(err);
  }
});

// PUT /items/:id
router.put('/:id', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const itemId = req.params.id;
    const {
      type,
      encrypted_payload,
      nonce,
      item_version,
      updated_at,
      device_id,
    } = req.body;

    const validationError = validateItemFields({ type, encrypted_payload, nonce });
    if (validationError) return res.status(400).json({ error: validationError });

    // Check ownership
    const existing = await query('SELECT id FROM vault_items WHERE id = $1 AND user_id = $2', [itemId, userId]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    const result = await upsertItem({
      id: itemId,
      userId,
      type,
      encrypted_payload,
      nonce,
      item_version,
      device_id,
      updated_at,
    });

    await writeAuditLog({ userId, action: 'item_write', deviceId: device_id, itemId });

    return res.json({ item: result });
  } catch (err) {
    next(err);
  }
});

// DELETE /items/:id (soft-delete)
router.delete('/:id', async (req, res, next) => {
  try {
    const userId = req.user.id;
    const itemId = req.params.id;

    // Archive current version before soft-deleting
    const existing = await query(
      'SELECT * FROM vault_items WHERE id = $1 AND user_id = $2',
      [itemId, userId],
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Item not found.' });
    }

    const item = existing.rows[0];
    await query(
      `INSERT INTO vault_item_history
         (item_id, user_id, encrypted_payload, nonce, item_version, device_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [item.id, item.user_id, item.encrypted_payload, item.nonce, item.item_version, item.device_id],
    );

    await query(
      `UPDATE vault_items
       SET deleted = TRUE, updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [itemId, userId],
    );

    await writeAuditLog({ userId, action: 'item_delete', itemId });

    return res.status(204).send();
  } catch (err) {
    next(err);
  }
});

// ─── Shared helpers ───────────────────────────────────────────────────────────

async function upsertItem({ id, userId, type, encrypted_payload, nonce, item_version, device_id, updated_at }) {
  // Archive current version if updating
  if (id) {
    const existing = await query(
      'SELECT * FROM vault_items WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    if (existing.rows.length > 0) {
      const old = existing.rows[0];
      await query(
        `INSERT INTO vault_item_history
           (item_id, user_id, encrypted_payload, nonce, item_version, device_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [old.id, old.user_id, old.encrypted_payload, old.nonce, old.item_version, old.device_id],
      ).catch(() => {}); // Non-fatal if history insert fails
    }
  }

  const sql = id
    ? `INSERT INTO vault_items
         (id, user_id, type, encrypted_payload, nonce, item_version, device_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE SET
         type              = EXCLUDED.type,
         encrypted_payload = EXCLUDED.encrypted_payload,
         nonce             = EXCLUDED.nonce,
         item_version      = EXCLUDED.item_version,
         device_id         = EXCLUDED.device_id,
         updated_at        = EXCLUDED.updated_at
       RETURNING *`
    : `INSERT INTO vault_items
         (user_id, type, encrypted_payload, nonce, item_version, device_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`;

  const params = id
    ? [id, userId, type, encrypted_payload, nonce, item_version || 1, device_id, updated_at || new Date()]
    : [userId, type, encrypted_payload, nonce, item_version || 1, device_id, updated_at || new Date()];

  const result = await query(sql, params);
  return result.rows[0];
}

function validateItemFields({ type, encrypted_payload, nonce }) {
  if (!['login', 'note', 'card', 'identity'].includes(type)) {
    return `Invalid item type: "${type}". Must be one of: login, note, card, identity.`;
  }
  if (!encrypted_payload) return 'encrypted_payload is required.';
  if (!nonce)             return 'nonce is required.';
  return null;
}

/**
 * Writes a breach-resistant audit log entry.
 * @param {{ userId: string, action: string, deviceId?: string, itemId?: string, ipHash?: string, userAgent?: string }} opts
 */
async function writeAuditLog({ userId, action, deviceId, itemId, ipHash, userAgent }) {
  await query(
    `INSERT INTO audit_log (user_id, action, device_id, item_id, ip_hash, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, action, deviceId || null, itemId || null, ipHash || null, userAgent || null],
  );
}

module.exports = router;
module.exports.writeAuditLog = writeAuditLog;

/**
 * BYOV Vault Module
 *
 * Manages the vault lifecycle: creation, unlock, lock, item CRUD, import/export.
 *
 * Vault file format (BYOV/1):
 * {
 *   "format":             "BYOV/1",
 *   "salt":               "<base64>",        // Argon2id salt
 *   "wrapped_vault_key":  "<base64>",        // AES-256-GCM(vaultKey, KEK)
 *   "wrapped_vault_nonce":"<base64>",        // nonce for the above
 *   "device_id":          "<uuid>",
 *   "created_at":         "<iso>",
 *   "updated_at":         "<iso>",
 *   "sync_token":         "version_0",
 *   "items":              [ ...EncryptedItem ]
 * }
 *
 * EncryptedItem:
 * {
 *   "id":                "<uuid>",
 *   "type":              "login|note|card|identity",
 *   "encrypted_payload": "<base64>",        // XChaCha20-Poly1305(item JSON, vaultKey)
 *   "nonce":             "<base64>",
 *   "item_version":       1,
 *   "updated_at":        "<iso>",
 *   "device_id":         "<uuid>"
 * }
 */

import { v4 as uuidv4 } from 'uuid';
import {
  deriveMasterKey,
  generateSalt,
  generateVaultKey,
  wrapVaultKey,
  unwrapVaultKey,
  encryptItem,
  decryptItem,
  bufToBase64,
  base64ToBuf,
  zeroMemory,
} from './crypto.js';

export const VAULT_FORMAT = 'BYOV/1';

/** In-memory vault session – cleared on lock() */
let _session = null;

// ─── Session helpers ─────────────────────────────────────────────────────────

/** Returns true if a vault is currently unlocked in memory. */
export function isUnlocked() {
  return _session !== null;
}

/** Clears all in-memory key material – effectively locks the vault. */
export function lockVault() {
  if (_session) {
    zeroMemory(_session.vaultKey);
    zeroMemory(_session.kek);
    _session = null;
  }
}

// ─── Vault Creation ───────────────────────────────────────────────────────────

/**
 * Creates a brand-new, empty vault encrypted with the given master password.
 *
 * @param {string} masterPassword
 * @param {string} [deviceId]     – UUID identifying this device; auto-generated if omitted
 * @returns {Promise<object>}       Vault header object (serialisable to JSON)
 */
export async function createVault(masterPassword, deviceId = uuidv4()) {
  const salt = generateSalt();
  const kek = await deriveMasterKey(masterPassword, salt);
  const vaultKey = await generateVaultKey();
  const { ciphertext: wrappedKey, nonce: wrappedNonce } = await wrapVaultKey(vaultKey, kek);

  const now = new Date().toISOString();
  const vault = {
    format: VAULT_FORMAT,
    salt: bufToBase64(salt),
    wrapped_vault_key: wrappedKey,
    wrapped_vault_nonce: wrappedNonce,
    device_id: deviceId,
    created_at: now,
    updated_at: now,
    sync_token: 'version_0',
    items: [],
  };

  // Unlock the session so callers can immediately use the vault
  _session = { vaultKey, kek, deviceId };

  // Clean up KEK – it is retained in _session for password-change flow
  // but callers should call lockVault() when done.
  return vault;
}

// ─── Unlock / Lock ───────────────────────────────────────────────────────────

/**
 * Unlocks an existing vault with the given master password.
 * Derives the KEK, unwraps the vault key, and stores both in the session.
 *
 * @param {string} masterPassword
 * @param {object} vaultHeader    – the vault's header fields (without items array)
 * @returns {Promise<void>}
 * @throws If the password is wrong (decryption will fail with a crypto error).
 */
export async function unlockVault(masterPassword, vaultHeader) {
  const salt = base64ToBuf(vaultHeader.salt);
  const kek = await deriveMasterKey(masterPassword, salt);

  // This throws if the password is wrong (AES-GCM authentication failure)
  const vaultKey = await unwrapVaultKey(
    vaultHeader.wrapped_vault_key,
    vaultHeader.wrapped_vault_nonce,
    kek,
  );

  _session = {
    vaultKey,
    kek,
    deviceId: vaultHeader.device_id,
  };
}

// ─── Item CRUD ────────────────────────────────────────────────────────────────

/**
 * Encrypts a new vault item and returns an EncryptedItem ready for storage.
 *
 * @param {object} itemData   – plain-text item: { title, username, password, url, notes, ... }
 * @param {string} itemType   – 'login' | 'note' | 'card' | 'identity'
 * @returns {Promise<object>}   EncryptedItem
 */
export async function addItem(itemData, itemType = 'login') {
  assertUnlocked();
  const { ciphertext, nonce } = await encryptItem(itemData, _session.vaultKey);
  return {
    id: uuidv4(),
    type: itemType,
    encrypted_payload: ciphertext,
    nonce,
    item_version: 1,
    updated_at: new Date().toISOString(),
    device_id: _session.deviceId,
  };
}

/**
 * Decrypts a single EncryptedItem and returns its plain-text data.
 *
 * @param {object} encryptedItem
 * @returns {Promise<object>} Plain-text item data
 */
export async function decryptVaultItem(encryptedItem) {
  assertUnlocked();
  return decryptItem(encryptedItem.encrypted_payload, encryptedItem.nonce, _session.vaultKey);
}

/**
 * Updates an existing encrypted item with new plain-text data.
 * Increments item_version and updates timestamps.
 *
 * @param {object} existingEncryptedItem – the stored EncryptedItem
 * @param {object} updatedData           – new plain-text item data
 * @returns {Promise<object>}              Updated EncryptedItem
 */
export async function updateItem(existingEncryptedItem, updatedData) {
  assertUnlocked();
  const { ciphertext, nonce } = await encryptItem(updatedData, _session.vaultKey);
  return {
    ...existingEncryptedItem,
    encrypted_payload: ciphertext,
    nonce,
    item_version: (existingEncryptedItem.item_version || 1) + 1,
    updated_at: new Date().toISOString(),
    device_id: _session.deviceId,
  };
}

// ─── Password Change ──────────────────────────────────────────────────────────

/**
 * Re-derives the KEK from a new master password and re-wraps the vault key.
 * Returns the updated vault header fields. Does NOT change the vault key or items.
 *
 * @param {string} newMasterPassword
 * @param {object} currentVaultHeader
 * @returns {Promise<object>} Updated header fields to merge into vault header
 */
export async function changeMasterPassword(newMasterPassword, currentVaultHeader) {
  assertUnlocked();

  const newSalt = generateSalt();
  const newKek = await deriveMasterKey(newMasterPassword, newSalt);
  const { ciphertext: wrappedKey, nonce: wrappedNonce } = await wrapVaultKey(
    _session.vaultKey,
    newKek,
  );

  // Replace the KEK in the session
  zeroMemory(_session.kek);
  _session.kek = newKek;

  return {
    ...currentVaultHeader,
    salt: bufToBase64(newSalt),
    wrapped_vault_key: wrappedKey,
    wrapped_vault_nonce: wrappedNonce,
    updated_at: new Date().toISOString(),
  };
}

// ─── Export / Import ──────────────────────────────────────────────────────────

/**
 * Serialises the entire vault (header + items) to a JSON string, suitable for
 * saving as a portable .byov file.
 *
 * @param {object}   vaultHeader – header object (format, salt, wrapped_vault_key, …)
 * @param {object[]} items       – array of EncryptedItems
 * @returns {string} JSON string
 */
export function exportVault(vaultHeader, items) {
  const exported = {
    ...vaultHeader,
    items,
    exported_at: new Date().toISOString(),
  };
  return JSON.stringify(exported, null, 2);
}

/**
 * Parses an exported vault JSON string, validates its format, and returns the
 * header and items separately.
 *
 * @param {string} jsonString – raw JSON from a .byov file
 * @returns {{ header: object, items: object[] }}
 * @throws {Error} If the format is unrecognised or required fields are missing.
 */
export function importVault(jsonString) {
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch {
    throw new Error('Invalid vault file: not valid JSON.');
  }

  if (parsed.format !== VAULT_FORMAT) {
    throw new Error(
      `Unsupported vault format: "${parsed.format}". Expected "${VAULT_FORMAT}".`,
    );
  }

  const required = ['salt', 'wrapped_vault_key', 'wrapped_vault_nonce'];
  for (const field of required) {
    if (!parsed[field]) {
      throw new Error(`Invalid vault file: missing required field "${field}".`);
    }
  }

  const { items = [], ...header } = parsed;
  return { header, items };
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function assertUnlocked() {
  if (!_session) {
    throw new Error('Vault is locked. Call unlockVault() first.');
  }
}

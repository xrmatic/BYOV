/**
 * BYOV Crypto Module
 *
 * Key derivation:  Argon2id (master password → Key Encryption Key)
 * Vault key wrap:  AES-256-GCM (WebCrypto, wraps/unwraps vault key)
 * Item encryption: XChaCha20-Poly1305 (libsodium, encrypts individual items)
 *
 * Two-level key scheme:
 *   masterPassword + salt → KEK (via Argon2id)
 *   KEK encrypts/decrypts a random vaultKey (AES-256-GCM)
 *   vaultKey encrypts/decrypts individual vault items (XChaCha20-Poly1305)
 *
 * This allows:
 *   - Password change: only re-wrap vaultKey with new KEK
 *   - Multiple devices: each has its own copy of the wrapped vaultKey
 *   - Zero-knowledge sync: server only stores encrypted blobs
 */

import argon2 from 'argon2-browser';
import sodium from 'libsodium-wrappers';

// ─── Argon2id Parameters (OWASP minimum recommended) ───────────────────────

/** Argon2id configuration – memory in KiB, tuned for ~0.5 s on mid-range hardware */
export const ARGON2_PARAMS = {
  type: argon2.ArgonType.Argon2id,
  mem: 65536,        // 64 MiB
  time: 3,           // 3 iterations
  parallelism: 4,
  hashLen: 32,       // 256-bit KEK
};

/** Salt length in bytes for Argon2id */
export const SALT_BYTES = 32;

// ─── Argon2id – Master Password Derivation ──────────────────────────────────

/**
 * Derives a 256-bit Key Encryption Key (KEK) from the master password.
 *
 * @param {string}     masterPassword – plain-text master password
 * @param {Uint8Array} salt           – random salt (SALT_BYTES bytes); stored
 *                                      in the vault header, never secret.
 * @returns {Promise<Uint8Array>}       32-byte KEK
 */
export async function deriveMasterKey(masterPassword, salt) {
  if (!masterPassword || masterPassword.length === 0) {
    throw new Error('Master password must not be empty');
  }
  if (!(salt instanceof Uint8Array) || salt.length !== SALT_BYTES) {
    throw new Error(`Salt must be a ${SALT_BYTES}-byte Uint8Array`);
  }

  const result = await argon2.hash({
    pass: masterPassword,
    salt,
    ...ARGON2_PARAMS,
  });

  return result.hash; // Uint8Array[32]
}

/**
 * Generates a cryptographically random Argon2 salt.
 * @returns {Uint8Array}
 */
export function generateSalt() {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  return salt;
}

// ─── AES-256-GCM – Vault Key Wrapping (WebCrypto) ───────────────────────────

/** AES-GCM nonce length (96-bit / 12 bytes as per NIST SP 800-38D) */
const AES_GCM_NONCE_BYTES = 12;

/**
 * Imports a raw 32-byte key as a WebCrypto CryptoKey for AES-256-GCM.
 * @param {Uint8Array} rawKey
 * @param {string[]}   usages – e.g. ['wrapKey','unwrapKey'] or ['encrypt','decrypt']
 * @returns {Promise<CryptoKey>}
 */
async function importAesGcmKey(rawKey, usages) {
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM', length: 256 }, false, usages);
}

/**
 * Generates a random 256-bit vault key (used for item encryption).
 * @returns {Promise<Uint8Array>} 32-byte random key
 */
export async function generateVaultKey() {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}

/**
 * Wraps (encrypts) the vaultKey with the KEK using AES-256-GCM.
 *
 * @param {Uint8Array} vaultKey  – 32-byte vault key to protect
 * @param {Uint8Array} kek       – 32-byte Key Encryption Key derived from password
 * @returns {Promise<{ciphertext: string, nonce: string}>} Base64-encoded outputs
 */
export async function wrapVaultKey(vaultKey, kek) {
  const nonce = new Uint8Array(AES_GCM_NONCE_BYTES);
  crypto.getRandomValues(nonce);

  const kekCryptoKey = await importAesGcmKey(kek, ['encrypt']);
  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    kekCryptoKey,
    vaultKey,
  );

  return {
    ciphertext: bufToBase64(new Uint8Array(ciphertextBuf)),
    nonce: bufToBase64(nonce),
  };
}

/**
 * Unwraps (decrypts) a previously wrapped vault key.
 *
 * @param {string} ciphertextB64 – Base64-encoded ciphertext from wrapVaultKey
 * @param {string} nonceB64      – Base64-encoded nonce from wrapVaultKey
 * @param {Uint8Array} kek       – 32-byte KEK
 * @returns {Promise<Uint8Array>} 32-byte vault key
 */
export async function unwrapVaultKey(ciphertextB64, nonceB64, kek) {
  const ciphertext = base64ToBuf(ciphertextB64);
  const nonce = base64ToBuf(nonceB64);

  const kekCryptoKey = await importAesGcmKey(kek, ['decrypt']);
  const plaintextBuf = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce },
    kekCryptoKey,
    ciphertext,
  );

  return new Uint8Array(plaintextBuf);
}

// ─── XChaCha20-Poly1305 – Item Encryption (libsodium) ───────────────────────

/**
 * Ensures libsodium is ready. Call before any sodium operations.
 * @returns {Promise<void>}
 */
export async function sodiumReady() {
  await sodium.ready;
}

/**
 * Encrypts a vault item payload with XChaCha20-Poly1305.
 *
 * @param {object}     plaintext  – arbitrary JSON-serialisable item data
 * @param {Uint8Array} vaultKey   – 32-byte vault key
 * @returns {Promise<{ciphertext: string, nonce: string}>}
 */
export async function encryptItem(plaintext, vaultKey) {
  await sodium.ready;

  const message = new TextEncoder().encode(JSON.stringify(plaintext));
  // XChaCha20-Poly1305 needs a 24-byte nonce
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);

  const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    message,
    null,          // no additional data
    null,          // no secret nonce
    nonce,
    vaultKey,
  );

  return {
    ciphertext: bufToBase64(ciphertext),
    nonce: bufToBase64(nonce),
  };
}

/**
 * Decrypts a vault item payload encrypted with encryptItem.
 *
 * @param {string}     ciphertextB64 – Base64 ciphertext
 * @param {string}     nonceB64      – Base64 nonce
 * @param {Uint8Array} vaultKey      – 32-byte vault key
 * @returns {Promise<object>}          Decrypted item data
 */
export async function decryptItem(ciphertextB64, nonceB64, vaultKey) {
  await sodium.ready;

  const ciphertext = base64ToBuf(ciphertextB64);
  const nonce = base64ToBuf(nonceB64);

  const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
    null,          // no secret nonce
    ciphertext,
    null,          // no additional data
    nonce,
    vaultKey,
  );

  return JSON.parse(new TextDecoder().decode(plaintext));
}

// ─── Utility Helpers ─────────────────────────────────────────────────────────

/**
 * Converts a Uint8Array to a URL-safe Base64 string.
 * @param {Uint8Array} buf
 * @returns {string}
 */
export function bufToBase64(buf) {
  return btoa(String.fromCharCode(...buf))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Converts a URL-safe Base64 string back to a Uint8Array.
 * @param {string} b64
 * @returns {Uint8Array}
 */
export function base64ToBuf(b64) {
  // Restore standard Base64 padding
  const std = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded = std.padEnd(std.length + ((4 - (std.length % 4)) % 4), '=');
  const binary = atob(padded);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buf[i] = binary.charCodeAt(i);
  }
  return buf;
}

/**
 * Constant-time comparison of two Uint8Arrays.
 * Prevents timing attacks when comparing MACs / hashes.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
export function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Securely zeroes a Uint8Array buffer to prevent key material lingering in
 * memory.  Call this when a key is no longer needed.
 * @param {Uint8Array} buf
 */
export function zeroMemory(buf) {
  if (buf instanceof Uint8Array) {
    buf.fill(0);
  }
}

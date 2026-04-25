/**
 * Mock for libsodium-wrappers in Jest tests.
 * Implements minimal XChaCha20-Poly1305 stubs using Node's built-in crypto.
 * Uses AES-256-GCM as a stand-in (semantically equivalent for testing purposes).
 */

const nodeCrypto = require('crypto');

const crypto_aead_xchacha20poly1305_ietf_NPUBBYTES = 24;
const crypto_secretbox_NONCEBYTES = 24;

function randombytes_buf(length) {
  return nodeCrypto.randomBytes(length);
}

function crypto_aead_xchacha20poly1305_ietf_encrypt(message, ad, _secretNonce, nonce, key) {
  // Use AES-256-GCM as a stand-in for testing
  // Key must be 32 bytes; nonce truncated/padded to 12 bytes for GCM
  const gcmNonce = nonce.slice(0, 12);
  const cipher = nodeCrypto.createCipheriv('aes-256-gcm', Buffer.from(key), gcmNonce);
  if (ad) cipher.setAAD(ad);
  const enc = Buffer.concat([cipher.update(message), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([enc, tag]);
}

function crypto_aead_xchacha20poly1305_ietf_decrypt(_secretNonce, ciphertext, ad, nonce, key) {
  const gcmNonce = nonce.slice(0, 12);
  const tag = ciphertext.slice(-16);
  const enc = ciphertext.slice(0, -16);
  const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', Buffer.from(key), gcmNonce);
  decipher.setAuthTag(tag);
  if (ad) decipher.setAAD(ad);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

function to_base64(buf) {
  return Buffer.from(buf).toString('base64url');
}

function from_base64(b64) {
  return Buffer.from(b64, 'base64url');
}

const ready = Promise.resolve();

module.exports = {
  ready,
  crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
  crypto_secretbox_NONCEBYTES,
  randombytes_buf,
  crypto_aead_xchacha20poly1305_ietf_encrypt,
  crypto_aead_xchacha20poly1305_ietf_decrypt,
  to_base64,
  from_base64,
};

module.exports.default = module.exports;

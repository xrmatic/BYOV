/**
 * Jest global setup file.
 * Polyfills browser APIs that are missing or incomplete in the jsdom/Node.js test environment.
 */

'use strict';

// ── WebCrypto ──────────────────────────────────────────────────────────────────
// jsdom (< v22) may not expose crypto.subtle; fall back to Node.js built-in.
if (typeof globalThis.crypto === 'undefined' || !globalThis.crypto.subtle) {
  const { webcrypto } = require('crypto');
  globalThis.crypto = webcrypto;
}

// ── TextEncoder / TextDecoder ──────────────────────────────────────────────────
// Older jsdom environments may not expose these as globals.
if (typeof globalThis.TextEncoder === 'undefined') {
  const { TextEncoder, TextDecoder } = require('util');
  globalThis.TextEncoder = TextEncoder;
  globalThis.TextDecoder = TextDecoder;
}

// ── btoa / atob ────────────────────────────────────────────────────────────────
// Available in Node.js >= 16.0.0 / jsdom. Provide fallbacks just in case.
if (typeof globalThis.btoa === 'undefined') {
  globalThis.btoa = (str) => Buffer.from(str, 'binary').toString('base64');
  globalThis.atob = (b64) => Buffer.from(b64, 'base64').toString('binary');
}

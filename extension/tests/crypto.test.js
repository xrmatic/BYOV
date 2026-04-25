/**
 * Tests for the BYOV crypto module.
 *
 * Uses mocked argon2-browser and libsodium-wrappers (see __mocks__/).
 * The WebCrypto API is provided by jsdom (via jest-environment-jsdom) or
 * the Node.js global crypto object (Node 19+).
 */

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
  timingSafeEqual,
  zeroMemory,
  SALT_BYTES,
} from '../src/crypto/crypto.js';

// ─── Setup WebCrypto in jsdom ─────────────────────────────────────────────────

// jest-environment-jsdom does not always expose WebCrypto; polyfill with Node's.
if (!globalThis.crypto?.subtle) {
  const { webcrypto } = require('crypto');
  globalThis.crypto = webcrypto;
}

// ─── generateSalt ─────────────────────────────────────────────────────────────

describe('generateSalt', () => {
  test('returns a Uint8Array of the correct length', () => {
    const salt = generateSalt();
    expect(salt).toBeInstanceOf(Uint8Array);
    expect(salt.length).toBe(SALT_BYTES);
  });

  test('returns different values on each call', () => {
    const a = generateSalt();
    const b = generateSalt();
    // The probability of two random 32-byte arrays being equal is negligible
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

// ─── deriveMasterKey ──────────────────────────────────────────────────────────

describe('deriveMasterKey', () => {
  test('returns a 32-byte Uint8Array', async () => {
    const salt = generateSalt();
    const key = await deriveMasterKey('test-password', salt);
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  test('is deterministic for the same password + salt', async () => {
    const salt = generateSalt();
    const key1 = await deriveMasterKey('my-secret-password', salt);
    const key2 = await deriveMasterKey('my-secret-password', salt);
    expect(timingSafeEqual(key1, key2)).toBe(true);
  });

  test('produces different output for different passwords', async () => {
    const salt = generateSalt();
    const key1 = await deriveMasterKey('password-one', salt);
    const key2 = await deriveMasterKey('password-two', salt);
    expect(timingSafeEqual(key1, key2)).toBe(false);
  });

  test('produces different output for different salts', async () => {
    const salt1 = generateSalt();
    const salt2 = generateSalt();
    const key1 = await deriveMasterKey('same-password', salt1);
    const key2 = await deriveMasterKey('same-password', salt2);
    expect(timingSafeEqual(key1, key2)).toBe(false);
  });

  test('throws for empty master password', async () => {
    const salt = generateSalt();
    await expect(deriveMasterKey('', salt)).rejects.toThrow('Master password must not be empty');
  });

  test('throws for invalid salt', async () => {
    await expect(deriveMasterKey('password', new Uint8Array(16))).rejects.toThrow('Salt must be a');
  });
});

// ─── Vault key – wrap / unwrap ─────────────────────────────────────────────────

describe('wrapVaultKey / unwrapVaultKey', () => {
  test('round-trips the vault key', async () => {
    const kek = new Uint8Array(32);
    crypto.getRandomValues(kek);
    const vaultKey = await generateVaultKey();

    const { ciphertext, nonce } = await wrapVaultKey(vaultKey, kek);
    const recovered = await unwrapVaultKey(ciphertext, nonce, kek);
    expect(timingSafeEqual(vaultKey, recovered)).toBe(true);
  });

  test('fails to unwrap with a wrong KEK', async () => {
    const kek1 = new Uint8Array(32).fill(1);
    const kek2 = new Uint8Array(32).fill(2);
    const vaultKey = await generateVaultKey();

    const { ciphertext, nonce } = await wrapVaultKey(vaultKey, kek1);
    await expect(unwrapVaultKey(ciphertext, nonce, kek2)).rejects.toThrow();
  });

  test('each wrap produces different ciphertext (random nonce)', async () => {
    const kek = new Uint8Array(32).fill(9);
    const vaultKey = await generateVaultKey();

    const w1 = await wrapVaultKey(vaultKey, kek);
    const w2 = await wrapVaultKey(vaultKey, kek);
    expect(w1.ciphertext).not.toBe(w2.ciphertext);
    expect(w1.nonce).not.toBe(w2.nonce);
  });
});

// ─── Item encryption ──────────────────────────────────────────────────────────

describe('encryptItem / decryptItem', () => {
  let vaultKey;
  beforeEach(async () => {
    vaultKey = await generateVaultKey();
  });

  test('round-trips a login item', async () => {
    const item = {
      title:    'GitHub',
      username: 'alice@example.com',
      password: 'super-secret-123',
      url:      'https://github.com',
    };
    const { ciphertext, nonce } = await encryptItem(item, vaultKey);
    const decrypted = await decryptItem(ciphertext, nonce, vaultKey);
    expect(decrypted).toEqual(item);
  });

  test('round-trips a secure note', async () => {
    const note = { note_title: 'Secret Note', note_body: 'My private thoughts', notes: '' };
    const { ciphertext, nonce } = await encryptItem(note, vaultKey);
    const decrypted = await decryptItem(ciphertext, nonce, vaultKey);
    expect(decrypted).toEqual(note);
  });

  test('produces different ciphertext each call (random nonce)', async () => {
    const item = { title: 'Test', password: '123' };
    const enc1 = await encryptItem(item, vaultKey);
    const enc2 = await encryptItem(item, vaultKey);
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    expect(enc1.nonce).not.toBe(enc2.nonce);
  });

  test('fails to decrypt with wrong vault key', async () => {
    const wrongKey = await generateVaultKey();
    const item = { title: 'Test', password: '456' };
    const { ciphertext, nonce } = await encryptItem(item, vaultKey);
    await expect(decryptItem(ciphertext, nonce, wrongKey)).rejects.toThrow();
  });

  test('handles items with unicode characters', async () => {
    const item = { title: '日本語テスト', password: '🔐🔑', notes: 'ñoño café' };
    const { ciphertext, nonce } = await encryptItem(item, vaultKey);
    const decrypted = await decryptItem(ciphertext, nonce, vaultKey);
    expect(decrypted).toEqual(item);
  });
});

// ─── Base64 encoding helpers ──────────────────────────────────────────────────

describe('bufToBase64 / base64ToBuf', () => {
  test('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255, 42, 99]);
    const b64 = bufToBase64(bytes);
    const recovered = base64ToBuf(b64);
    expect(recovered).toEqual(bytes);
  });

  test('produces URL-safe base64 (no + / = chars)', () => {
    // Test many values to catch edge cases
    for (let i = 0; i < 100; i++) {
      const buf = new Uint8Array(32);
      crypto.getRandomValues(buf);
      const b64 = bufToBase64(buf);
      expect(b64).not.toMatch(/[+/=]/);
    }
  });

  test('empty buffer round-trips', () => {
    const b64 = bufToBase64(new Uint8Array(0));
    const recovered = base64ToBuf(b64);
    expect(recovered.length).toBe(0);
  });
});

// ─── timingSafeEqual ─────────────────────────────────────────────────────────

describe('timingSafeEqual', () => {
  test('returns true for identical arrays', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(timingSafeEqual(a, b)).toBe(true);
  });

  test('returns false for different arrays', () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const b = new Uint8Array([1, 2, 3, 5]);
    expect(timingSafeEqual(a, b)).toBe(false);
  });

  test('returns false for different lengths', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array([1, 2, 3, 4]);
    expect(timingSafeEqual(a, b)).toBe(false);
  });
});

// ─── zeroMemory ──────────────────────────────────────────────────────────────

describe('zeroMemory', () => {
  test('fills buffer with zeros', () => {
    const buf = new Uint8Array([1, 2, 3, 4, 5]);
    zeroMemory(buf);
    expect(buf.every((b) => b === 0)).toBe(true);
  });

  test('is a no-op for non-Uint8Array values', () => {
    expect(() => zeroMemory(null)).not.toThrow();
    expect(() => zeroMemory(undefined)).not.toThrow();
    expect(() => zeroMemory('string')).not.toThrow();
  });
});

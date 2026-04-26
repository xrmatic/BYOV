/**
 * Tests for the BYOV vault module.
 */

import {
  createVault,
  unlockVault,
  lockVault,
  isUnlocked,
  addItem,
  decryptVaultItem,
  updateItem,
  changeMasterPassword,
  exportVault,
  importVault,
  verifyMasterPassword,
  VAULT_FORMAT,
} from '../src/crypto/vault.js';

// Polyfill WebCrypto for jsdom
if (!globalThis.crypto?.subtle) {
  const { webcrypto } = require('crypto');
  globalThis.crypto = webcrypto;
}

// ─── createVault ─────────────────────────────────────────────────────────────

describe('createVault', () => {
  afterEach(() => lockVault());

  test('returns a vault header with required fields', async () => {
    const header = await createVault('master-password-123');
    expect(header.format).toBe(VAULT_FORMAT);
    expect(header.salt).toBeTruthy();
    expect(header.wrapped_vault_key).toBeTruthy();
    expect(header.wrapped_vault_nonce).toBeTruthy();
    expect(header.items).toEqual([]);
    expect(header.device_id).toBeTruthy();
  });

  test('unlocks the vault session after creation', async () => {
    await createVault('password-xyz');
    expect(isUnlocked()).toBe(true);
  });
});

// ─── unlockVault / lockVault ─────────────────────────────────────────────────

describe('unlockVault / lockVault', () => {
  let header;

  beforeEach(async () => {
    header = await createVault('test-password-456');
    lockVault();
  });

  test('unlocks with the correct password', async () => {
    await unlockVault('test-password-456', header);
    expect(isUnlocked()).toBe(true);
    lockVault();
  });

  test('throws with the wrong password', async () => {
    await expect(unlockVault('wrong-password', header)).rejects.toThrow();
    expect(isUnlocked()).toBe(false);
  });

  test('lockVault clears the session', async () => {
    await unlockVault('test-password-456', header);
    expect(isUnlocked()).toBe(true);
    lockVault();
    expect(isUnlocked()).toBe(false);
  });
});

// ─── addItem / decryptVaultItem ───────────────────────────────────────────────

describe('addItem / decryptVaultItem', () => {
  beforeEach(async () => {
    await createVault('item-test-password');
  });
  afterEach(() => lockVault());

  test('encrypts and returns an EncryptedItem', async () => {
    const plain = { title: 'GitHub', username: 'user@example.com', password: 'secret' };
    const enc = await addItem(plain, 'login');
    expect(enc.id).toBeTruthy();
    expect(enc.type).toBe('login');
    expect(enc.encrypted_payload).toBeTruthy();
    expect(enc.nonce).toBeTruthy();
    expect(enc.item_version).toBe(1);
    expect(enc.created_at).toBeTruthy();
    expect(enc.updated_at).toBeTruthy();
  });

  test('round-trips the item data', async () => {
    const plain = { title: 'MyApp', username: 'alice', password: 'pw123', url: 'https://app.com' };
    const enc = await addItem(plain, 'login');
    const decrypted = await decryptVaultItem(enc);
    expect(decrypted).toEqual(plain);
  });

  test('throws when vault is locked', async () => {
    lockVault();
    await expect(addItem({ title: 'x' }, 'login')).rejects.toThrow('Vault is locked');
  });
});

// ─── updateItem ──────────────────────────────────────────────────────────────

describe('updateItem', () => {
  beforeEach(async () => {
    await createVault('update-test-password');
  });
  afterEach(() => lockVault());

  test('increments item_version', async () => {
    const enc = await addItem({ title: 'A', password: 'old' }, 'login');
    expect(enc.item_version).toBe(1);
    const updated = await updateItem(enc, { title: 'A', password: 'new' });
    expect(updated.item_version).toBe(2);
    expect(updated.created_at).toBe(enc.created_at);
  });

  test('decrypts to new data after update', async () => {
    const enc = await addItem({ title: 'A', password: 'old' }, 'login');
    const updated = await updateItem(enc, { title: 'A', password: 'new-password' });
    const plain = await decryptVaultItem(updated);
    expect(plain.password).toBe('new-password');
  });
});

// ─── changeMasterPassword ─────────────────────────────────────────────────────

describe('changeMasterPassword', () => {
  test('re-wraps vault key; items remain decryptable', async () => {
    const header = await createVault('original-password');
    const enc = await addItem({ title: 'Test', password: '123' }, 'login');

    const newHeader = await changeMasterPassword('new-password-789', header);
    expect(newHeader.salt).not.toBe(header.salt);
    expect(newHeader.wrapped_vault_key).not.toBe(header.wrapped_vault_key);

    lockVault();

    // Old password should no longer work
    await expect(unlockVault('original-password', newHeader)).rejects.toThrow();

    // New password should work
    await unlockVault('new-password-789', newHeader);
    expect(isUnlocked()).toBe(true);

    // Item should still decrypt
    const plain = await decryptVaultItem(enc);
    expect(plain.password).toBe('123');

    lockVault();
  });
});

describe('verifyMasterPassword', () => {
  test('returns true for the correct password and false for the wrong one', async () => {
    const header = await createVault('verify-password');
    lockVault();

    await expect(verifyMasterPassword('verify-password', header)).resolves.toBe(true);
    await expect(verifyMasterPassword('wrong-password', header)).resolves.toBe(false);
  });
});

// ─── exportVault / importVault ────────────────────────────────────────────────

describe('exportVault / importVault', () => {
  let header;
  let items;

  beforeEach(async () => {
    header = await createVault('export-test-password');
    const enc = await addItem({ title: 'GitHub', password: 'abc' }, 'login');
    items = [enc];
    lockVault();
  });

  test('exportVault produces valid JSON', () => {
    const json = exportVault(header, items);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  test('exported JSON contains format field', () => {
    const json = exportVault(header, items);
    const parsed = JSON.parse(json);
    expect(parsed.format).toBe(VAULT_FORMAT);
  });

  test('importVault parses header and items correctly', () => {
    const json = exportVault(header, items);
    const { header: importedHeader, items: importedItems } = importVault(json);
    expect(importedHeader.format).toBe(VAULT_FORMAT);
    expect(importedHeader.salt).toBe(header.salt);
    expect(importedItems).toHaveLength(1);
  });

  test('importVault throws for unknown format', () => {
    const json = JSON.stringify({ format: 'OTHER/99', salt: 'abc', wrapped_vault_key: 'x', wrapped_vault_nonce: 'y' });
    expect(() => importVault(json)).toThrow('Unsupported vault format');
  });

  test('importVault throws for invalid JSON', () => {
    expect(() => importVault('not json')).toThrow('Invalid vault file');
  });

  test('importVault throws for missing required fields', () => {
    const json = JSON.stringify({ format: VAULT_FORMAT });
    expect(() => importVault(json)).toThrow('missing required field');
  });

  test('round-trip: export then import then unlock', async () => {
    const json = exportVault(header, items);
    const { header: importedHeader } = importVault(json);
    await unlockVault('export-test-password', importedHeader);
    expect(isUnlocked()).toBe(true);
    lockVault();
  });
});

/**
 * Tests for the BYOV Sync API.
 *
 * Uses supertest against a test instance of the Express server.
 * Database interactions are mocked via the db/client module.
 */

'use strict';

// Mock the database client before requiring the app
jest.mock('../db/client', () => ({
  query: jest.fn(),
  getPool: jest.fn(),
  getSupabase: jest.fn(),
}));

const request = require('supertest');
const app     = require('../server');
const { query } = require('../db/client');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001';
const TEST_ITEM_ID = '00000000-0000-0000-0000-000000000002';
const TEST_DEVICE_ID = '00000000-0000-0000-0000-000000000003';

/** Creates a test JWT that our auth middleware will accept in dev mode. */
function makeTestToken(userId = TEST_USER_ID) {
  const jwt = require('jsonwebtoken');
  return jwt.sign({ sub: userId, email: 'test@example.com' }, 'test-secret', { expiresIn: '1h' });
}

function authHeaders(userId) {
  return { Authorization: `Bearer ${makeTestToken(userId)}` };
}

// ─── Health check ─────────────────────────────────────────────────────────────

describe('GET /health', () => {
  test('returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

// ─── Vault header ─────────────────────────────────────────────────────────────

describe('GET /vault/header', () => {
  test('returns 401 without auth token', async () => {
    const res = await request(app).get('/vault/header');
    expect(res.status).toBe(401);
  });

  test('returns 404 when no vault exists', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .get('/vault/header')
      .set(authHeaders());
    expect(res.status).toBe(404);
    expect(res.body.header).toBeNull();
  });

  test('returns vault header when it exists', async () => {
    const header = {
      user_id:            TEST_USER_ID,
      format:             'BYOV/1',
      salt:               'dGVzdHNhbHQ',
      wrapped_vault_key:  'dGVzdA',
      wrapped_vault_nonce:'bm9uY2U',
      device_id:          TEST_DEVICE_ID,
      sync_token:         'version_0',
    };
    query.mockResolvedValueOnce({ rows: [header] });
    const res = await request(app)
      .get('/vault/header')
      .set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.header.format).toBe('BYOV/1');
    expect(res.body.header.salt).toBe('dGVzdHNhbHQ');
  });
});

describe('PUT /vault/header', () => {
  test('returns 400 when required fields are missing', async () => {
    const res = await request(app)
      .put('/vault/header')
      .set(authHeaders())
      .send({ format: 'BYOV/1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  test('upserts vault header and returns it', async () => {
    const savedHeader = {
      user_id:            TEST_USER_ID,
      format:             'BYOV/1',
      salt:               'dGVzdHNhbHQ',
      wrapped_vault_key:  'dGVzdA',
      wrapped_vault_nonce:'bm9uY2U',
      device_id:          TEST_DEVICE_ID,
      sync_token:         'version_0',
    };
    query.mockResolvedValueOnce({ rows: [savedHeader] });
    const res = await request(app)
      .put('/vault/header')
      .set(authHeaders())
      .send({
        salt:               'dGVzdHNhbHQ',
        wrapped_vault_key:  'dGVzdA',
        wrapped_vault_nonce:'bm9uY2U',
        device_id:          TEST_DEVICE_ID,
      });
    expect(res.status).toBe(200);
    expect(res.body.header.salt).toBe('dGVzdHNhbHQ');
  });
});

// ─── Sync ──────────────────────────────────────────────────────────────────────

describe('GET /sync', () => {
  test('returns 401 without auth', async () => {
    const res = await request(app).get('/sync');
    expect(res.status).toBe(401);
  });

  test('returns empty items array for a new vault', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // items query
    query.mockResolvedValueOnce({ rows: [] }); // audit log (ignored)
    const res = await request(app)
      .get('/sync?since=version_0')
      .set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.sync_token).toMatch(/^version_\d+$/);
  });

  test('returns changed items', async () => {
    const items = [
      {
        id: TEST_ITEM_ID,
        user_id: TEST_USER_ID,
        type: 'login',
        encrypted_payload: 'abc123',
        nonce: 'nonce123',
        item_version: 1,
        updated_at: new Date().toISOString(),
        device_id: TEST_DEVICE_ID,
        deleted: false,
      },
    ];
    query.mockResolvedValueOnce({ rows: items });
    query.mockResolvedValueOnce({ rows: [] }); // audit log
    const res = await request(app)
      .get('/sync')
      .set(authHeaders());
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].encrypted_payload).toBe('abc123');
    expect(res.body.count).toBe(1);
  });
});

// ─── Items ─────────────────────────────────────────────────────────────────────

describe('POST /items', () => {
  test('returns 400 for invalid item type', async () => {
    const res = await request(app)
      .post('/items')
      .set(authHeaders())
      .send({
        type: 'invalid-type',
        encrypted_payload: 'abc',
        nonce: 'xyz',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid item type/i);
  });

  test('returns 400 when encrypted_payload is missing', async () => {
    const res = await request(app)
      .post('/items')
      .set(authHeaders())
      .send({ type: 'login', nonce: 'xyz' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/encrypted_payload/i);
  });

  test('creates a new login item', async () => {
    const newItem = {
      id: TEST_ITEM_ID,
      user_id: TEST_USER_ID,
      type: 'login',
      encrypted_payload: 'enc-payload-base64',
      nonce: 'nonce-base64',
      item_version: 1,
      device_id: TEST_DEVICE_ID,
      deleted: false,
      updated_at: new Date().toISOString(),
    };
    query.mockResolvedValueOnce({ rows: [newItem] }); // upsert
    query.mockResolvedValueOnce({ rows: [] });         // audit log
    const res = await request(app)
      .post('/items')
      .set(authHeaders())
      .send({
        type: 'login',
        encrypted_payload: 'enc-payload-base64',
        nonce: 'nonce-base64',
        device_id: TEST_DEVICE_ID,
      });
    expect(res.status).toBe(201);
    expect(res.body.item.encrypted_payload).toBe('enc-payload-base64');
  });
});

describe('DELETE /items/:id', () => {
  test('returns 401 without auth', async () => {
    const res = await request(app).delete(`/items/${TEST_ITEM_ID}`);
    expect(res.status).toBe(401);
  });

  test('returns 404 when item does not exist', async () => {
    query.mockResolvedValueOnce({ rows: [] }); // select existing
    const res = await request(app)
      .delete(`/items/${TEST_ITEM_ID}`)
      .set(authHeaders());
    expect(res.status).toBe(404);
  });

  test('soft-deletes an existing item', async () => {
    const existingItem = {
      id: TEST_ITEM_ID,
      user_id: TEST_USER_ID,
      type: 'login',
      encrypted_payload: 'enc',
      nonce: 'nonce',
      item_version: 1,
      device_id: TEST_DEVICE_ID,
    };
    query.mockResolvedValueOnce({ rows: [existingItem] }); // select
    query.mockResolvedValueOnce({ rows: [] });              // archive to history
    query.mockResolvedValueOnce({ rows: [] });              // update deleted = true
    query.mockResolvedValueOnce({ rows: [] });              // audit log
    const res = await request(app)
      .delete(`/items/${TEST_ITEM_ID}`)
      .set(authHeaders());
    expect(res.status).toBe(204);
  });
});

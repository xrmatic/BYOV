/**
 * SupabaseStorageProvider
 *
 * Stores encrypted vault data directly in Supabase Postgres via PostgREST,
 * using the official supabase-js client. There is NO custom backend in
 * between — Row-Level Security in Postgres is the only access control,
 * which is exactly what RLS is designed for.
 *
 * Required config:
 *   { supabaseUrl: 'https://xxx.supabase.co', supabaseAnonKey: 'eyJ…' }
 *
 * The user must call signUp() / signIn() before vault operations; the
 * supabase-js client persists the session in chrome.storage automatically.
 */

import { StorageProvider } from './StorageProvider.js';
import { createClient } from '@supabase/supabase-js';

const TABLE_HEADERS = 'vault_headers';
const TABLE_ITEMS   = 'vault_items';

export class SupabaseStorageProvider extends StorageProvider {
  constructor() {
    super();
    this._client = null;
  }

  get name() { return 'Supabase'; }
  get type() { return 'supabase'; }

  async connect(config) {
    const { supabaseUrl, supabaseAnonKey } = config;
    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error('Supabase requires supabaseUrl and supabaseAnonKey.');
    }
    this._client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // Custom storage adapter so the session survives across MV3 restarts
        storage: chromeStorageAdapter(),
      },
    });
  }

  async disconnect() {
    if (this._client) {
      await this._client.auth.signOut().catch(() => {});
      this._client = null;
    }
  }

  // ── Auth ────────────────────────────────────────────────────────────────────

  async signUp(email, password) {
    this._assertConnected();
    const { data, error } = await this._client.auth.signUp({ email, password });
    if (error) throw new Error(error.message);
    return data;
  }

  async signIn(email, password) {
    this._assertConnected();
    const { data, error } = await this._client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    return data;
  }

  async getCurrentUser() {
    this._assertConnected();
    const { data } = await this._client.auth.getUser();
    return data?.user || null;
  }

  // ── StorageProvider interface ────────────────────────────────────────────────

  async saveVaultHeader(userId, header) {
    this._assertConnected();
    const row = {
      user_id:             userId,
      format:              header.format || 'BYOV/1',
      salt:                header.salt,
      wrapped_vault_key:   header.wrapped_vault_key,
      wrapped_vault_nonce: header.wrapped_vault_nonce,
      device_id:           header.device_id,
      sync_token:          header.sync_token || 'version_0',
      updated_at:          new Date().toISOString(),
    };
    const { error } = await this._client
      .from(TABLE_HEADERS)
      .upsert(row, { onConflict: 'user_id' });
    if (error) throw new Error(error.message);
  }

  async loadVaultHeader(userId) {
    this._assertConnected();
    const { data, error } = await this._client
      .from(TABLE_HEADERS)
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
  }

  async saveItem(userId, item) {
    this._assertConnected();
    // user_id is enforced by RLS; we set it explicitly to satisfy WITH CHECK.
    const row = {
      id:                item.id,
      user_id:           userId,
      type:              item.type,
      encrypted_payload: item.encrypted_payload,
      nonce:             item.nonce,
      item_version:      item.item_version || 1,
      device_id:         item.device_id,
      updated_at:        item.updated_at || new Date().toISOString(),
      deleted:           !!item.deleted,
    };
    const { error } = await this._client
      .from(TABLE_ITEMS)
      .upsert(row, { onConflict: 'id' });
    if (error) throw new Error(error.message);
  }

  async deleteItem(userId, itemId) {
    this._assertConnected();
    const { error } = await this._client
      .from(TABLE_ITEMS)
      .update({ deleted: true, updated_at: new Date().toISOString() })
      .eq('id', itemId)
      .eq('user_id', userId);
    if (error) throw new Error(error.message);
  }

  async getChanges(userId, since = 'version_0') {
    this._assertConnected();
    const sinceMs = parseToken(since);
    let query = this._client
      .from(TABLE_ITEMS)
      .select('*')
      .eq('user_id', userId)
      .order('updated_at', { ascending: true });

    if (sinceMs > 0) {
      query = query.gt('updated_at', new Date(sinceMs).toISOString());
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return {
      items: data || [],
      syncToken: `version_${Date.now()}`,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  _assertConnected() {
    if (!this._client) throw new Error('SupabaseStorageProvider: call connect() first.');
  }
}

function parseToken(token) {
  if (!token || token === 'version_0') return 0;
  const m = token.match(/version_(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

/**
 * supabase-js expects a localStorage-like sync API. chrome.storage is async,
 * so we wrap it. Sessions are small (a JWT + refresh token) so this is fine.
 */
function chromeStorageAdapter() {
  if (typeof chrome === 'undefined' || !chrome.storage) {
    return undefined; // fall back to default in-memory storage
  }
  return {
    async getItem(key) {
      const res = await chrome.storage.local.get(key);
      return res[key] || null;
    },
    async setItem(key, value) {
      await chrome.storage.local.set({ [key]: value });
    },
    async removeItem(key) {
      await chrome.storage.local.remove(key);
    },
  };
}

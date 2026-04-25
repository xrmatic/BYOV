/**
 * SupabaseStorageProvider
 *
 * Stores encrypted vault data via the BYOV Sync API backed by Supabase/Postgres.
 * Relies on the REST sync API (api/server.js) rather than the Supabase JS client
 * directly, so the server handles all DB interactions.
 *
 * Required config:
 *   { apiUrl: 'https://…', anonKey: '…' }
 *
 * On first connect the provider authenticates with the API and stores a JWT.
 * All subsequent requests attach the JWT as a Bearer token.
 */

import { StorageProvider } from './StorageProvider.js';
import { createClient } from '@supabase/supabase-js';

export class SupabaseStorageProvider extends StorageProvider {
  constructor() {
    super();
    this._client = null;
    this._apiUrl = null;
    this._jwt    = null;
  }

  get name() { return 'Supabase Sync'; }
  get type() { return 'supabase'; }

  async connect(config) {
    const { supabaseUrl, supabaseAnonKey, apiUrl } = config;
    this._apiUrl = apiUrl || supabaseUrl;
    this._client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }

  async disconnect() {
    if (this._client) {
      await this._client.auth.signOut();
      this._client = null;
      this._jwt = null;
    }
  }

  // ── Auth helpers (exposed for UI layer) ─────────────────────────────────────

  async signUp(email, password) {
    this._assertConnected();
    const { data, error } = await this._client.auth.signUp({ email, password });
    if (error) throw new Error(error.message);
    this._jwt = data.session?.access_token;
    return data;
  }

  async signIn(email, password) {
    this._assertConnected();
    const { data, error } = await this._client.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
    this._jwt = data.session?.access_token;
    return data;
  }

  async signOut() {
    await this.disconnect();
  }

  getUser() {
    this._assertConnected();
    return this._client.auth.getUser();
  }

  onAuthChange(callback) {
    this._assertConnected();
    return this._client.auth.onAuthStateChange((_event, session) => {
      this._jwt = session?.access_token || null;
      callback(session?.user || null);
    });
  }

  // ── StorageProvider interface ────────────────────────────────────────────────

  async saveVaultHeader(userId, header) {
    await this._request('PUT', `/vault/header`, { user_id: userId, ...header });
  }

  async loadVaultHeader(userId) {
    const res = await this._request('GET', `/vault/header?user_id=${encodeURIComponent(userId)}`);
    return res.header || null;
  }

  async saveItem(userId, item) {
    await this._request('POST', `/items`, { user_id: userId, ...item });
  }

  async deleteItem(userId, itemId) {
    await this._request('DELETE', `/items/${encodeURIComponent(itemId)}`);
  }

  async getChanges(userId, since = 'version_0') {
    const res = await this._request(
      'GET',
      `/sync?user_id=${encodeURIComponent(userId)}&since=${encodeURIComponent(since)}`,
    );
    return { items: res.items || [], syncToken: res.sync_token || 'version_0' };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  async _request(method, path, body) {
    const url = `${this._apiUrl}${path}`;
    const headers = {
      'Content-Type': 'application/json',
      ...(this._jwt ? { Authorization: `Bearer ${this._jwt}` } : {}),
    };

    const options = {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    };

    const response = await fetch(url, options);
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${response.status}`);
    }
    // 204 No Content
    if (response.status === 204) return {};
    return response.json();
  }

  _assertConnected() {
    if (!this._client) throw new Error('SupabaseStorageProvider: call connect() first.');
  }
}

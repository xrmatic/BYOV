/**
 * DropboxStorageProvider
 *
 * Stores the encrypted vault as /Apps/BYOV/vault.byov in the user's Dropbox.
 *
 * Uses the Dropbox API v2 with OAuth2 PKCE.
 *
 * Required config:
 *   { clientId: '…', redirectUri: '…' }
 */

import { StorageProvider } from './StorageProvider.js';

const API_BASE     = 'https://api.dropboxapi.com/2';
const CONTENT_BASE = 'https://content.dropboxapi.com/2';
const VAULT_PATH   = '/Apps/BYOV/vault.byov';
const AUTH_ENDPOINT  = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_ENDPOINT = 'https://api.dropboxapi.com/oauth2/token';

export class DropboxStorageProvider extends StorageProvider {
  constructor() {
    super();
    this._accessToken  = null;
    this._refreshToken = null;
    this._clientId     = null;
    this._redirectUri  = null;
    this._tokenExpiry  = 0;
  }

  get name() { return 'Dropbox'; }
  get type() { return 'dropbox'; }

  async connect(config) {
    const { clientId, redirectUri, accessToken, refreshToken, tokenExpiry } = config;
    this._clientId    = clientId;
    this._redirectUri = redirectUri;

    if (accessToken) {
      this._accessToken  = accessToken;
      this._refreshToken = refreshToken || null;
      this._tokenExpiry  = tokenExpiry  || 0;
    }
  }

  /**
   * Returns the Dropbox OAuth2 PKCE authorisation URL and PKCE verifier.
   * @returns {Promise<{ url: string, verifier: string }>}
   */
  async getAuthUrl() {
    const verifier  = this._generateVerifier();
    const challenge = await this._generateChallenge(verifier);

    const params = new URLSearchParams({
      client_id:             this._clientId,
      redirect_uri:          this._redirectUri,
      response_type:         'code',
      token_access_type:     'offline',
      code_challenge:        challenge,
      code_challenge_method: 'S256',
    });

    return { url: `${AUTH_ENDPOINT}?${params}`, verifier };
  }

  async handleOAuthCallback(code, verifier) {
    const body = new URLSearchParams({
      client_id:     this._clientId,
      redirect_uri:  this._redirectUri,
      grant_type:    'authorization_code',
      code,
      code_verifier: verifier,
    });

    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || 'Dropbox OAuth failed');

    this._accessToken  = data.access_token;
    this._refreshToken = data.refresh_token || null;
    this._tokenExpiry  = Date.now() + (data.expires_in || 14400) * 1000;
  }

  // ── StorageProvider interface ────────────────────────────────────────────────

  async saveVaultHeader(userId, header) {
    const current = await this._readVaultFile() || {};
    await this._writeVaultFile({ ...current, ...header, user_id: userId });
  }

  async loadVaultHeader(userId) {
    const vault = await this._readVaultFile();
    if (!vault) return null;
    const { items: _items, ...header } = vault;
    return header;
  }

  async saveItem(userId, item) {
    const vault = await this._readVaultFile() || { user_id: userId, items: [] };
    const items = vault.items || [];
    const idx = items.findIndex((i) => i.id === item.id);
    if (idx >= 0) items[idx] = item;
    else items.push(item);
    await this._writeVaultFile({ ...vault, items });
  }

  async deleteItem(userId, itemId) {
    const vault = await this._readVaultFile();
    if (!vault) return;
    const items = (vault.items || []).map((i) =>
      i.id === itemId ? { ...i, deleted: true, updated_at: new Date().toISOString() } : i,
    );
    await this._writeVaultFile({ ...vault, items });
  }

  async getChanges(userId, since = 'version_0') {
    const vault = await this._readVaultFile();
    if (!vault) return { items: [], syncToken: 'version_0' };

    const sinceTs = this._parseToken(since);
    const items = (vault.items || []).filter((i) => {
      if (sinceTs === 0) return true;
      return new Date(i.updated_at).getTime() > sinceTs;
    });

    return { items, syncToken: `version_${Date.now()}` };
  }

  async saveFullVault(userId, header, items) {
    await this._writeVaultFile({ ...header, user_id: userId, items });
  }

  async loadFullVault(userId) {
    const vault = await this._readVaultFile();
    if (!vault) return { header: null, items: [] };
    const { items = [], ...header } = vault;
    return { header, items: items.filter((i) => !i.deleted) };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  async _readVaultFile() {
    await this._ensureToken();
    const res = await fetch(`${CONTENT_BASE}/files/download`, {
      method: 'POST',
      headers: {
        Authorization:       `Bearer ${this._accessToken}`,
        'Dropbox-API-Arg':   JSON.stringify({ path: VAULT_PATH }),
        'Content-Type':      'text/plain; charset=dropbox-cors-hack',
      },
    });
    if (res.status === 409) return null; // file not found
    if (!res.ok) throw new Error(`Dropbox read failed: HTTP ${res.status}`);
    return res.json();
  }

  async _writeVaultFile(data) {
    await this._ensureToken();
    const body = JSON.stringify(data);
    const res = await fetch(`${CONTENT_BASE}/files/upload`, {
      method: 'POST',
      headers: {
        Authorization:     `Bearer ${this._accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({ path: VAULT_PATH, mode: 'overwrite' }),
        'Content-Type':    'application/octet-stream',
      },
      body,
    });
    if (!res.ok) throw new Error(`Dropbox write failed: HTTP ${res.status}`);
  }

  async _ensureToken() {
    if (!this._accessToken) throw new Error('Dropbox: not authenticated. Call getAuthUrl().');
    if (Date.now() < this._tokenExpiry - 60000) return;
    if (this._refreshToken) await this._refreshAccessToken();
  }

  async _refreshAccessToken() {
    const body = new URLSearchParams({
      client_id:     this._clientId,
      grant_type:    'refresh_token',
      refresh_token: this._refreshToken,
    });
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || 'Dropbox token refresh failed');
    this._accessToken = data.access_token;
    if (data.refresh_token) this._refreshToken = data.refresh_token;
    this._tokenExpiry = Date.now() + (data.expires_in || 14400) * 1000;
  }

  _generateVerifier() {
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    return btoa(String.fromCharCode(...buf)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async _generateChallenge(verifier) {
    const encoder = new TextEncoder();
    const hash = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
    return btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  _parseToken(token) {
    const m = token.match(/version_(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }
}

/**
 * OneDriveStorageProvider
 *
 * Stores the encrypted vault as a single JSON file in the user's OneDrive,
 * under Apps/BYOV/vault.byov.
 *
 * Uses the Microsoft Graph API with PKCE OAuth2.
 *
 * Required config:
 *   { clientId: '…', tenantId: '…' (optional, defaults to 'common') }
 */

import { StorageProvider } from './StorageProvider.js';

const GRAPH_API  = 'https://graph.microsoft.com/v1.0';
const VAULT_PATH = '/me/drive/special/approot:/vault.byov:/content';
const VAULT_META = '/me/drive/special/approot:/vault.byov';
const SCOPES     = ['Files.ReadWrite.AppFolder', 'User.Read'];
const AUTH_BASE  = 'https://login.microsoftonline.com';

export class OneDriveStorageProvider extends StorageProvider {
  constructor() {
    super();
    this._accessToken  = null;
    this._refreshToken = null;
    this._clientId     = null;
    this._tenantId     = 'common';
    this._tokenExpiry  = 0;
  }

  get name() { return 'OneDrive'; }
  get type() { return 'onedrive'; }

  async connect(config) {
    const { clientId, tenantId = 'common', accessToken, refreshToken, tokenExpiry } = config;
    this._clientId    = clientId;
    this._tenantId    = tenantId;

    if (accessToken) {
      this._accessToken  = accessToken;
      this._refreshToken = refreshToken || null;
      this._tokenExpiry  = tokenExpiry  || 0;
    }
  }

  /**
   * Initiates the OAuth2 PKCE flow. Returns the authorisation URL to redirect to.
   * After the redirect, call handleOAuthCallback(url) with the callback URL.
   *
   * @param {string} redirectUri
   * @returns {Promise<{ url: string, verifier: string }>}
   */
  async getAuthUrl(redirectUri) {
    const verifier  = this._generateVerifier();
    const challenge = await this._generateChallenge(verifier);

    const params = new URLSearchParams({
      client_id:             this._clientId,
      response_type:         'code',
      redirect_uri:          redirectUri,
      scope:                 SCOPES.join(' '),
      code_challenge:        challenge,
      code_challenge_method: 'S256',
    });

    const url = `${AUTH_BASE}/${this._tenantId}/oauth2/v2.0/authorize?${params}`;
    return { url, verifier };
  }

  /**
   * Exchanges the authorisation code (from the OAuth callback) for tokens.
   * @param {string} code
   * @param {string} verifier  – the PKCE verifier from getAuthUrl()
   * @param {string} redirectUri
   */
  async handleOAuthCallback(code, verifier, redirectUri) {
    const body = new URLSearchParams({
      client_id:     this._clientId,
      grant_type:    'authorization_code',
      code,
      redirect_uri:  redirectUri,
      code_verifier: verifier,
    });

    const res = await fetch(
      `${AUTH_BASE}/${this._tenantId}/oauth2/v2.0/token`,
      { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || 'OneDrive OAuth failed');

    this._accessToken  = data.access_token;
    this._refreshToken = data.refresh_token || null;
    this._tokenExpiry  = Date.now() + data.expires_in * 1000;
  }

  // ── StorageProvider interface ────────────────────────────────────────────────

  /**
   * OneDrive uses a single vault.byov file; header + items are stored together.
   */
  async saveVaultHeader(userId, header) {
    const current = await this._readVaultFile();
    const updated = { ...current, ...header, user_id: userId };
    await this._writeVaultFile(updated);
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
    if (idx >= 0) {
      items[idx] = item;
    } else {
      items.push(item);
    }
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
    const res = await fetch(`${GRAPH_API}${VAULT_PATH}`, {
      headers: { Authorization: `Bearer ${this._accessToken}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`OneDrive read failed: HTTP ${res.status}`);
    return res.json();
  }

  async _writeVaultFile(data) {
    await this._ensureToken();
    const body = JSON.stringify(data);
    const res = await fetch(`${GRAPH_API}${VAULT_PATH}`, {
      method: 'PUT',
      headers: {
        Authorization:  `Bearer ${this._accessToken}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    if (!res.ok) throw new Error(`OneDrive write failed: HTTP ${res.status}`);
  }

  async _ensureToken() {
    if (!this._accessToken) throw new Error('OneDrive: not authenticated. Call getAuthUrl().');
    if (Date.now() < this._tokenExpiry - 60000) return; // still valid
    if (this._refreshToken) await this._refreshAccessToken();
  }

  async _refreshAccessToken() {
    const body = new URLSearchParams({
      client_id:     this._clientId,
      grant_type:    'refresh_token',
      refresh_token: this._refreshToken,
    });
    const res = await fetch(
      `${AUTH_BASE}/${this._tenantId}/oauth2/v2.0/token`,
      { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || 'OneDrive token refresh failed');
    this._accessToken  = data.access_token;
    this._refreshToken = data.refresh_token || this._refreshToken;
    this._tokenExpiry  = Date.now() + data.expires_in * 1000;
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

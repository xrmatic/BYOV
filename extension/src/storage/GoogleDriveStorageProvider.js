/**
 * GoogleDriveStorageProvider
 *
 * Stores the encrypted vault as vault.byov in the user's Google Drive
 * Application Data folder (hidden from the user's regular Drive view).
 *
 * Uses the Google Drive REST API v3 with OAuth2 PKCE.
 *
 * Required config:
 *   { clientId: '…', redirectUri: '…' }
 */

import { StorageProvider } from './StorageProvider.js';

const DRIVE_API    = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API   = 'https://www.googleapis.com/upload/drive/v3';
const VAULT_NAME   = 'vault.byov';
const SCOPES       = ['https://www.googleapis.com/auth/drive.appdata'];
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export class GoogleDriveStorageProvider extends StorageProvider {
  constructor() {
    super();
    this._accessToken  = null;
    this._refreshToken = null;
    this._clientId     = null;
    this._redirectUri  = null;
    this._tokenExpiry  = 0;
    this._fileId       = null; // cached Drive file ID for vault.byov
  }

  get name() { return 'Google Drive'; }
  get type() { return 'googledrive'; }

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
   * Returns the OAuth2 PKCE authorisation URL.
   * @returns {Promise<{ url: string, verifier: string }>}
   */
  async getAuthUrl() {
    const verifier  = this._generateVerifier();
    const challenge = await this._generateChallenge(verifier);

    const params = new URLSearchParams({
      client_id:             this._clientId,
      redirect_uri:          this._redirectUri,
      response_type:         'code',
      scope:                 SCOPES.join(' '),
      code_challenge:        challenge,
      code_challenge_method: 'S256',
      access_type:           'offline',
      prompt:                'consent',
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
    if (!res.ok) throw new Error(data.error_description || 'Google Drive OAuth failed');

    this._accessToken  = data.access_token;
    this._refreshToken = data.refresh_token || null;
    this._tokenExpiry  = Date.now() + data.expires_in * 1000;
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
    const fileId = await this._findVaultFile();
    if (!fileId) return null;

    const res = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${this._accessToken}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Google Drive read failed: HTTP ${res.status}`);
    return res.json();
  }

  async _writeVaultFile(data) {
    await this._ensureToken();
    const body = JSON.stringify(data);
    const fileId = await this._findVaultFile();

    if (fileId) {
      // Update existing file
      const res = await fetch(`${UPLOAD_API}/files/${fileId}?uploadType=media`, {
        method: 'PATCH',
        headers: {
          Authorization:  `Bearer ${this._accessToken}`,
          'Content-Type': 'application/json',
        },
        body,
      });
      if (!res.ok) throw new Error(`Google Drive update failed: HTTP ${res.status}`);
    } else {
      // Create new file in appDataFolder
      const metadata = { name: VAULT_NAME, parents: ['appDataFolder'] };
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('file', new Blob([body], { type: 'application/json' }));

      const res = await fetch(`${UPLOAD_API}/files?uploadType=multipart`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this._accessToken}` },
        body: form,
      });
      if (!res.ok) throw new Error(`Google Drive create failed: HTTP ${res.status}`);
      const created = await res.json();
      this._fileId = created.id;
    }
  }

  async _findVaultFile() {
    if (this._fileId) return this._fileId;

    const q = encodeURIComponent(`name='${VAULT_NAME}' and 'appDataFolder' in parents and trashed=false`);
    const res = await fetch(`${DRIVE_API}/files?spaces=appDataFolder&q=${q}&fields=files(id)`, {
      headers: { Authorization: `Bearer ${this._accessToken}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    this._fileId = data.files?.[0]?.id || null;
    return this._fileId;
  }

  async _ensureToken() {
    if (!this._accessToken) throw new Error('Google Drive: not authenticated. Call getAuthUrl().');
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
    if (!res.ok) throw new Error(data.error_description || 'Google Drive token refresh failed');
    this._accessToken = data.access_token;
    this._tokenExpiry = Date.now() + data.expires_in * 1000;
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

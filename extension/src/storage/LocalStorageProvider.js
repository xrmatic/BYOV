/**
 * LocalStorageProvider
 *
 * Stores the encrypted vault in the browser's chrome.storage.local.
 * Best for offline-first usage or when no cloud sync is needed.
 * The vault is also exportable as a .byov file via the exportVault() call
 * in the UI layer.
 */

import { StorageProvider } from './StorageProvider.js';

const KEY_PREFIX = 'byov_';
const HEADER_KEY  = (uid) => `${KEY_PREFIX}header_${uid}`;
const ITEMS_KEY   = (uid) => `${KEY_PREFIX}items_${uid}`;
const VERSION_KEY = (uid) => `${KEY_PREFIX}version_${uid}`;

export class LocalStorageProvider extends StorageProvider {
  get name() { return 'Local Device'; }
  get type() { return 'local'; }

  // chrome.storage.local is injected; test environments can override this
  _storage() {
    return (typeof chrome !== 'undefined' && chrome.storage)
      ? chrome.storage.local
      : null;
  }

  async connect(_config) {
    // No connection needed for local storage
  }

  async saveVaultHeader(userId, header) {
    const key = HEADER_KEY(userId);
    await this._set({ [key]: header });
  }

  async loadVaultHeader(userId) {
    const key = HEADER_KEY(userId);
    const result = await this._get(key);
    return result[key] || null;
  }

  async saveItem(userId, item) {
    const itemsKey = ITEMS_KEY(userId);
    const result = await this._get(itemsKey);
    const items = result[itemsKey] || {};
    items[item.id] = item;
    await this._set({ [itemsKey]: items });
    await this._bumpVersion(userId);
  }

  async deleteItem(userId, itemId) {
    const itemsKey = ITEMS_KEY(userId);
    const result = await this._get(itemsKey);
    const items = result[itemsKey] || {};
    if (items[itemId]) {
      items[itemId] = { ...items[itemId], deleted: true, updated_at: new Date().toISOString() };
      await this._set({ [itemsKey]: items });
      await this._bumpVersion(userId);
    }
  }

  async getChanges(userId, since = 'version_0') {
    const itemsKey = ITEMS_KEY(userId);
    const versionKey = VERSION_KEY(userId);
    const result = await this._get([itemsKey, versionKey]);
    const itemsMap = result[itemsKey] || {};
    const currentVersion = result[versionKey] || 0;

    const sinceVersion = this._parseVersion(since);
    const items = Object.values(itemsMap).filter((item) => {
      if (!since || sinceVersion === 0) return true;
      return new Date(item.updated_at).getTime() > sinceVersion;
    });

    return {
      items,
      syncToken: `version_${currentVersion}`,
    };
  }

  async saveFullVault(userId, header, items) {
    const headerKey = HEADER_KEY(userId);
    const itemsKey  = ITEMS_KEY(userId);
    const versionKey = VERSION_KEY(userId);

    const itemsMap = {};
    for (const item of items) {
      itemsMap[item.id] = item;
    }

    await this._set({
      [headerKey]:  header,
      [itemsKey]:   itemsMap,
      [versionKey]: Date.now(),
    });
  }

  async loadFullVault(userId) {
    const headerKey = HEADER_KEY(userId);
    const itemsKey  = ITEMS_KEY(userId);
    const result = await this._get([headerKey, itemsKey]);

    const header = result[headerKey] || null;
    const itemsMap = result[itemsKey] || {};
    const items = Object.values(itemsMap).filter((item) => !item.deleted);

    return { header, items };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  _get(keys) {
    const storage = this._storage();
    if (!storage) {
      // Fallback for environments without chrome.storage
      const out = {};
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) {
        try { out[k] = JSON.parse(localStorage.getItem(k)); } catch { out[k] = null; }
      }
      return Promise.resolve(out);
    }
    return storage.get(keys);
  }

  _set(items) {
    const storage = this._storage();
    if (!storage) {
      for (const [k, v] of Object.entries(items)) {
        localStorage.setItem(k, JSON.stringify(v));
      }
      return Promise.resolve();
    }
    return storage.set(items);
  }

  async _bumpVersion(userId) {
    const key = VERSION_KEY(userId);
    await this._set({ [key]: Date.now() });
  }

  _parseVersion(token) {
    if (!token || token === 'version_0') return 0;
    const match = token.match(/version_(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }
}

/**
 * SyncManager
 *
 * Orchestrates syncing the local vault state with the active storage provider.
 *
 * Sync model:
 *   - Each item is an independent encrypted record.
 *   - Devices pull changes since their last sync token.
 *   - Conflict resolution: "last write wins" based on item.updated_at timestamp.
 *   - Item history is preserved by keeping a deleted flag instead of hard-deletes.
 *
 * The SyncManager itself is storage-provider-agnostic; it delegates all I/O to
 * the active StorageProvider instance.
 */

import { v4 as uuidv4 } from 'uuid';

export class SyncManager {
  /**
   * @param {import('../storage/StorageProvider.js').StorageProvider} provider
   * @param {string} userId
   * @param {string} deviceId
   */
  constructor(provider, userId, deviceId = uuidv4()) {
    this._provider = provider;
    this._userId   = userId;
    this._deviceId = deviceId;

    /** Local in-memory cache of EncryptedItems keyed by id. */
    this._localItems = {};

    /** The sync token returned by the last successful sync. */
    this._syncToken = 'version_0';

    /** ISO timestamp of last successful sync. */
    this._lastSyncAt = null;
  }

  // ── Getters ──────────────────────────────────────────────────────────────────

  get syncToken()  { return this._syncToken; }
  get lastSyncAt() { return this._lastSyncAt; }

  /** All non-deleted items from the local cache. */
  get items() {
    return Object.values(this._localItems).filter((i) => !i.deleted);
  }

  // ── Initialisation ────────────────────────────────────────────────────────────

  /**
   * Loads the initial vault state from the storage provider.
   * Call once after unlocking the vault.
   *
   * @returns {Promise<{ header: object|null, items: object[] }>}
   */
  async initialLoad() {
    const { header, items } = await this._provider.loadFullVault(this._userId);
    if (header) {
      this._syncToken = header.sync_token || 'version_0';
    }
    for (const item of items) {
      this._localItems[item.id] = item;
    }
    return { header, items };
  }

  // ── Sync ──────────────────────────────────────────────────────────────────────

  /**
   * Pulls remote changes since the last sync token and merges them into the
   * local cache using last-write-wins conflict resolution.
   *
   * @returns {Promise<{ added: number, updated: number, deleted: number }>}
   */
  async pull() {
    const { items: remoteItems, syncToken } = await this._provider.getChanges(
      this._userId,
      this._syncToken,
    );

    let added = 0, updated = 0, deleted = 0;

    for (const remote of remoteItems) {
      const local = this._localItems[remote.id];
      if (!local || this._isNewer(remote, local)) {
        const isNew = !local;
        this._localItems[remote.id] = remote;
        if (remote.deleted)  deleted++;
        else if (isNew)      added++;
        else                 updated++;
      }
    }

    this._syncToken  = syncToken;
    this._lastSyncAt = new Date().toISOString();

    return { added, updated, deleted };
  }

  /**
   * Pushes a single item to the storage provider and updates the local cache.
   * @param {object} encryptedItem – EncryptedItem to upsert
   * @returns {Promise<void>}
   */
  async pushItem(encryptedItem) {
    this._localItems[encryptedItem.id] = encryptedItem;
    await this._provider.saveItem(this._userId, encryptedItem);
  }

  /**
   * Soft-deletes an item locally and on the provider.
   * @param {string} itemId
   * @returns {Promise<void>}
   */
  async deleteItem(itemId) {
    const existing = this._localItems[itemId];
    if (!existing) return;

    const tombstone = {
      ...existing,
      deleted: true,
      updated_at: new Date().toISOString(),
      device_id: this._deviceId,
    };
    this._localItems[itemId] = tombstone;
    await this._provider.deleteItem(this._userId, itemId);
  }

  /**
   * Full sync: pull remote changes, then push any locally-modified items that
   * are newer than the last pull.  Returns a summary.
   *
   * @returns {Promise<{ pulled: object, pushed: number }>}
   */
  async sync() {
    const pulled = await this.pull();

    // Push items modified on this device since last sync
    const since = this._lastSyncAt ? new Date(this._lastSyncAt).getTime() : 0;
    let pushed = 0;

    for (const item of Object.values(this._localItems)) {
      if (item.device_id === this._deviceId) {
        const itemTime = new Date(item.updated_at).getTime();
        if (itemTime > since) {
          await this._provider.saveItem(this._userId, item);
          pushed++;
        }
      }
    }

    return { pulled, pushed };
  }

  // ── Item History ──────────────────────────────────────────────────────────────

  /**
   * Returns all versions of an item (including deleted tombstones) from the
   * provider.  Useful for auditing and recovery.
   *
   * Default implementation returns just the current version from local cache.
   * Override in sub-classes for full history support.
   *
   * @param {string} itemId
   * @returns {Promise<object[]>}
   */
  async getItemHistory(itemId) {
    const item = this._localItems[itemId];
    return item ? [item] : [];
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  /**
   * Returns true if `a` has a strictly later updated_at than `b`.
   */
  _isNewer(a, b) {
    return new Date(a.updated_at).getTime() > new Date(b.updated_at).getTime();
  }
}

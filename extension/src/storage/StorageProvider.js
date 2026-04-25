/**
 * StorageProvider – Abstract base class for all vault storage backends.
 *
 * All vault data passed to these methods is already encrypted.  Storage
 * providers never see plaintext.
 *
 * To add a new provider:
 *   1. Extend this class.
 *   2. Implement all abstract methods.
 *   3. Add the provider type to the factory in index.js.
 */
export class StorageProvider {
  /** @type {string} Human-readable provider name */
  get name() { throw new Error('Not implemented'); }

  /** @type {string} Unique provider type key */
  get type() { throw new Error('Not implemented'); }

  /**
   * Connects to the storage backend using the supplied configuration.
   * @param {object} config – provider-specific configuration (credentials, URLs, …)
   * @returns {Promise<void>}
   */
  async connect(_config) { throw new Error('Not implemented'); }

  /**
   * Disconnects and cleans up any open connections or cached tokens.
   * @returns {Promise<void>}
   */
  async disconnect() {}

  // ── Vault Header ────────────────────────────────────────────────────────────

  /**
   * Saves the vault header (encrypted, minus items array) for a user.
   * @param {string} userId
   * @param {object} header – serialisable vault header object
   * @returns {Promise<void>}
   */
  async saveVaultHeader(_userId, _header) { throw new Error('Not implemented'); }

  /**
   * Loads the vault header for a user.
   * @param {string} userId
   * @returns {Promise<object|null>}
   */
  async loadVaultHeader(_userId) { throw new Error('Not implemented'); }

  // ── Items ───────────────────────────────────────────────────────────────────

  /**
   * Upserts a single encrypted item.
   * @param {string} userId
   * @param {object} item – EncryptedItem
   * @returns {Promise<void>}
   */
  async saveItem(_userId, _item) { throw new Error('Not implemented'); }

  /**
   * Soft-deletes an item (marks it deleted, retains record for sync purposes).
   * @param {string} userId
   * @param {string} itemId
   * @returns {Promise<void>}
   */
  async deleteItem(_userId, _itemId) { throw new Error('Not implemented'); }

  /**
   * Returns all items changed since the given sync token.
   * @param {string} userId
   * @param {string} [since='version_0'] – sync token
   * @returns {Promise<{ items: object[], syncToken: string }>}
   */
  async getChanges(_userId, _since = 'version_0') { throw new Error('Not implemented'); }

  // ── Full Vault (import/export convenience) ──────────────────────────────────

  /**
   * Saves the entire encrypted vault (header + all items) atomically.
   * Default implementation calls saveVaultHeader + saveItem in series.
   * @param {string} userId
   * @param {object} header
   * @param {object[]} items
   * @returns {Promise<void>}
   */
  async saveFullVault(userId, header, items) {
    await this.saveVaultHeader(userId, header);
    for (const item of items) {
      await this.saveItem(userId, item);
    }
  }

  /**
   * Loads the entire encrypted vault.
   * Default implementation calls loadVaultHeader + getChanges.
   * @param {string} userId
   * @returns {Promise<{ header: object|null, items: object[] }>}
   */
  async loadFullVault(userId) {
    const header = await this.loadVaultHeader(userId);
    if (!header) return { header: null, items: [] };
    const { items } = await this.getChanges(userId);
    return { header, items };
  }
}

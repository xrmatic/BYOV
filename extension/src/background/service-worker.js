/**
 * BYOV Background Service Worker (Manifest V3)
 *
 * Responsibilities:
 *   - Manages vault session state (unlocked/locked).
 *   - Handles messages from popup and content scripts.
 *   - Runs periodic sync via chrome.alarms.
 *   - Handles context-menu autofill shortcuts.
 *   - Locks the vault after the configured auto-lock timeout.
 *
 * Message protocol (chrome.runtime.sendMessage / port.postMessage):
 *   { type: 'UNLOCK_VAULT',   payload: { masterPassword, storageType, storageConfig } }
 *   { type: 'LOCK_VAULT'                                                               }
 *   { type: 'GET_STATUS'                                                               }
 *   { type: 'GET_ITEMS'                                                                }
 *   { type: 'ADD_ITEM',       payload: { itemData, itemType }                          }
 *   { type: 'UPDATE_ITEM',    payload: { existingItem, updatedData }                   }
 *   { type: 'DELETE_ITEM',    payload: { itemId }                                      }
 *   { type: 'EXPORT_VAULT'                                                             }
 *   { type: 'IMPORT_VAULT',   payload: { jsonString, masterPassword }                  }
 *   { type: 'CREATE_VAULT',   payload: { masterPassword, storageType, storageConfig }  }
 *   { type: 'SYNC'                                                                     }
 *   { type: 'CHANGE_PASSWORD',payload: { newMasterPassword }                           }
 *   { type: 'AUTOFILL_QUERY', payload: { hostname }                                    }
 */

import { v4 as uuidv4 } from 'uuid';
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
} from '../crypto/vault.js';
import { createProvider } from '../storage/index.js';
import { SyncManager } from '../sync/SyncManager.js';

// ─── State ────────────────────────────────────────────────────────────────────

let _vaultHeader  = null;   // current vault header
let _syncManager  = null;   // SyncManager instance
let _provider     = null;   // active StorageProvider
let _userId       = null;   // authenticated user id
let _autoLockTimer = null;  // setTimeout handle

// ─── Constants ────────────────────────────────────────────────────────────────

const ALARM_SYNC      = 'byov_sync';
const ALARM_AUTO_LOCK = 'byov_auto_lock';
const DEFAULT_AUTO_LOCK_MINUTES = 15;
const SYNC_INTERVAL_MINUTES = 5;

// ─── Chrome alarm setup ───────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  // Periodic background sync
  chrome.alarms.create(ALARM_SYNC, { periodInMinutes: SYNC_INTERVAL_MINUTES });
  // Context menu
  chrome.contextMenus.create({
    id: 'byov_autofill',
    title: 'BYOV: Autofill credentials',
    contexts: ['editable'],
  });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_SYNC && isUnlocked() && _syncManager) {
    try {
      await _syncManager.sync();
    } catch (e) {
      console.warn('[BYOV] Background sync failed:', e.message);
    }
  }
  if (alarm.name === ALARM_AUTO_LOCK) {
    await _handleLock();
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'byov_autofill' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_AUTOFILL' });
  }
});

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((err) => {
    sendResponse({ success: false, error: err.message });
  });
  return true; // keep channel open for async response
});

async function handleMessage(message) {
  const { type, payload = {} } = message;

  switch (type) {
    case 'CREATE_VAULT':       return handleCreateVault(payload);
    case 'UNLOCK_VAULT':       return handleUnlock(payload);
    case 'LOCK_VAULT':         return handleLock();
    case 'GET_STATUS':         return getStatus();
    case 'GET_ITEMS':          return getItems();
    case 'ADD_ITEM':           return handleAddItem(payload);
    case 'UPDATE_ITEM':        return handleUpdateItem(payload);
    case 'DELETE_ITEM':        return handleDeleteItem(payload);
    case 'EXPORT_VAULT':       return handleExport();
    case 'IMPORT_VAULT':       return handleImport(payload);
    case 'SYNC':               return handleSync();
    case 'CHANGE_PASSWORD':    return handleChangePassword(payload);
    case 'AUTOFILL_QUERY':       return handleAutofillQuery(payload);
    case 'GET_ITEM_PLAINTEXT':   return handleGetItemPlaintext(payload);
    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleCreateVault({ masterPassword, storageType = 'local', storageConfig = {}, userId }) {
  _userId = userId || uuidv4();

  _provider = createProvider(storageType);
  await _provider.connect(storageConfig);

  const deviceId = await getOrCreateDeviceId();
  _vaultHeader = await createVault(masterPassword, deviceId);

  _syncManager = new SyncManager(_provider, _userId, deviceId);

  // Persist empty vault
  await _provider.saveFullVault(_userId, _vaultHeader, []);
  await persistVaultHeader();

  scheduleAutoLock();
  return { success: true, userId: _userId };
}

async function handleUnlock({ masterPassword, storageType = 'local', storageConfig = {}, userId }) {
  _userId   = userId;
  _provider = createProvider(storageType);
  await _provider.connect(storageConfig);

  const { header, items } = await _provider.loadFullVault(_userId);
  if (!header) {
    throw new Error('No vault found. Create one first.');
  }

  // This throws if the password is wrong
  await unlockVault(masterPassword, header);

  _vaultHeader = header;
  const deviceId = await getOrCreateDeviceId();
  _syncManager = new SyncManager(_provider, _userId, deviceId);

  // Seed the sync manager's local cache
  for (const item of items) {
    _syncManager._localItems[item.id] = item;
  }
  _syncManager._syncToken = header.sync_token || 'version_0';

  scheduleAutoLock();
  return { success: true };
}

async function handleLock() {
  await _handleLock();
  return { success: true };
}

async function _handleLock() {
  lockVault();
  _vaultHeader  = null;
  _syncManager  = null;
  if (_provider) {
    await _provider.disconnect().catch(() => {});
    _provider = null;
  }
  clearAutoLock();
}

function getStatus() {
  return {
    unlocked: isUnlocked(),
    userId: _userId,
    syncToken: _syncManager?.syncToken || null,
    lastSyncAt: _syncManager?.lastSyncAt || null,
    itemCount: _syncManager?.items.length || 0,
  };
}

async function getItems() {
  if (!isUnlocked() || !_syncManager) throw new Error('Vault is locked');
  return { items: _syncManager.items };
}

async function handleAddItem({ itemData, itemType = 'login' }) {
  if (!isUnlocked()) throw new Error('Vault is locked');
  const encryptedItem = await addItem(itemData, itemType);
  await _syncManager.pushItem(encryptedItem);
  await persistVaultHeader();
  return { success: true, item: encryptedItem };
}

async function handleUpdateItem({ existingItem, updatedData }) {
  if (!isUnlocked()) throw new Error('Vault is locked');
  const updated = await updateItem(existingItem, updatedData);
  await _syncManager.pushItem(updated);
  await persistVaultHeader();
  return { success: true, item: updated };
}

async function handleDeleteItem({ itemId }) {
  if (!isUnlocked()) throw new Error('Vault is locked');
  await _syncManager.deleteItem(itemId);
  await persistVaultHeader();
  return { success: true };
}

async function handleExport() {
  if (!isUnlocked()) throw new Error('Vault is locked');
  const items = _syncManager.items;
  const json = exportVault(_vaultHeader, items);
  return { success: true, json };
}

async function handleImport({ jsonString, masterPassword, storageType = 'local', storageConfig = {}, userId }) {
  const { header, items } = importVault(jsonString);

  // Verify the password unlocks the imported vault
  await unlockVault(masterPassword, header);

  _userId   = userId || uuidv4();
  _provider = createProvider(storageType);
  await _provider.connect(storageConfig);

  const deviceId = await getOrCreateDeviceId();
  _vaultHeader = { ...header, device_id: deviceId };

  _syncManager = new SyncManager(_provider, _userId, deviceId);
  for (const item of items) {
    _syncManager._localItems[item.id] = item;
  }

  await _provider.saveFullVault(_userId, _vaultHeader, items);
  scheduleAutoLock();
  return { success: true, userId: _userId, itemCount: items.length };
}

async function handleSync() {
  if (!isUnlocked() || !_syncManager) throw new Error('Vault is locked');
  const result = await _syncManager.sync();
  await persistVaultHeader();
  return { success: true, ...result };
}

async function handleChangePassword({ newMasterPassword }) {
  if (!isUnlocked()) throw new Error('Vault is locked');
  _vaultHeader = await changeMasterPassword(newMasterPassword, _vaultHeader);
  await _provider.saveVaultHeader(_userId, _vaultHeader);
  return { success: true };
}

async function handleGetItemPlaintext({ itemId }) {
  if (!isUnlocked() || !_syncManager) throw new Error('Vault is locked');
  const encItem = Object.values(_syncManager._localItems).find((i) => i.id === itemId);
  if (!encItem) throw new Error('Item not found');
  const plaintext = await decryptVaultItem(encItem);
  return { plaintext };
}

async function handleAutofillQuery({ hostname }) {
  if (!isUnlocked() || !_syncManager) return { items: [] };

  const matches = [];
  for (const encItem of _syncManager.items) {
    if (encItem.type !== 'login') continue;
    try {
      const plain = await decryptVaultItem(encItem);
      if (plain.url && hostnameMatches(plain.url, hostname)) {
        matches.push({
          id: encItem.id,
          title: plain.title || '',
          username: plain.username || '',
          // Never send the password in the query response; the content script
          // requests specific items by id when the user selects one.
          url: plain.url,
        });
      }
    } catch {
      // Skip items that fail to decrypt (wrong version, corruption, etc.)
    }
  }
  return { items: matches };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function persistVaultHeader() {
  if (!_vaultHeader || !_provider || !_userId) return;
  const updated = {
    ...(_vaultHeader),
    sync_token: _syncManager?.syncToken || 'version_0',
    updated_at: new Date().toISOString(),
  };
  _vaultHeader = updated;
  await _provider.saveVaultHeader(_userId, updated);
}

async function getOrCreateDeviceId() {
  const result = await chrome.storage.local.get('byov_device_id');
  if (result.byov_device_id) return result.byov_device_id;
  const id = uuidv4();
  await chrome.storage.local.set({ byov_device_id: id });
  return id;
}

function hostnameMatches(itemUrl, tabHostname) {
  try {
    const itemHost = new URL(itemUrl).hostname.replace(/^www\./, '');
    const tabHost  = tabHostname.replace(/^www\./, '');
    return itemHost === tabHost || tabHost.endsWith(`.${itemHost}`);
  } catch {
    return false;
  }
}

function scheduleAutoLock() {
  clearAutoLock();
  chrome.storage.local.get('byov_auto_lock_minutes', (res) => {
    const minutes = res.byov_auto_lock_minutes || DEFAULT_AUTO_LOCK_MINUTES;
    if (minutes > 0) {
      chrome.alarms.create(ALARM_AUTO_LOCK, { delayInMinutes: minutes });
    }
  });
}

function clearAutoLock() {
  chrome.alarms.clear(ALARM_AUTO_LOCK);
  if (_autoLockTimer) {
    clearTimeout(_autoLockTimer);
    _autoLockTimer = null;
  }
}

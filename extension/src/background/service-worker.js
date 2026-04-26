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
  getSessionSnapshot,
  restoreSession,
  verifyMasterPassword,
} from '../crypto/vault.js';
import { bufToBase64, base64ToBuf } from '../crypto/crypto.js';
import { createProvider } from '../storage/index.js';
import { SyncManager } from '../sync/SyncManager.js';

// ─── State ────────────────────────────────────────────────────────────────────

let _vaultHeader   = null;  // current vault header
let _syncManager   = null;  // SyncManager instance
let _provider      = null;  // active StorageProvider
let _userId        = null;  // authenticated user id
let _storageType   = null;  // for rehydration after MV3 worker eviction
let _storageConfig = null;  // for rehydration after MV3 worker eviction
let _autoLockTimer = null;  // setTimeout handle
const _autofillAuthorizations = new Map();

// MV3 service workers are evicted after ~30s of inactivity. We persist the
// unlocked session into chrome.storage.session (in-memory, cleared on browser
// close) so the next message can restore it. Lock clears the entry.
const SESSION_KEY = 'byov_session_v1';
const CONTENT_SCRIPT_ID = 'byov-content';
const GENERAL_SETTINGS_KEY = 'byov_general_settings';

// ─── Constants ────────────────────────────────────────────────────────────────

const ALARM_SYNC      = 'byov_sync';
const ALARM_AUTO_LOCK = 'byov_auto_lock';
const ALARM_CLIP_CLEAR = 'byov_clip_clear';
const DEFAULT_AUTO_LOCK_MINUTES = 15;
const SYNC_INTERVAL_MINUTES = 5;
const AUTOFILL_AUTH_TTL_MS = 10_000;

// ─── Chrome alarm setup ───────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  await restrictSessionStorageAccess();
  await syncContentScriptRegistration();
  // Periodic background sync
  chrome.alarms.create(ALARM_SYNC, { periodInMinutes: SYNC_INTERVAL_MINUTES });
  // Context menu
  chrome.contextMenus.create({
    id: 'byov_autofill',
    title: 'BYOV: Autofill credentials',
    contexts: ['editable'],
  });
});

chrome.runtime.onStartup.addListener(async () => {
  await restrictSessionStorageAccess();
  await syncContentScriptRegistration();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  if (changes[GENERAL_SETTINGS_KEY]) {
    syncContentScriptRegistration().catch((e) => {
      console.warn('[BYOV] Could not update content script registration:', e.message);
    });

    const settings = changes[GENERAL_SETTINGS_KEY].newValue || {};
    if (settings.allowSessionResume !== true) {
      chrome.storage.session.remove(SESSION_KEY).catch(() => {});
    }
  }
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
  if (alarm.name === ALARM_CLIP_CLEAR) {
    // Best-effort clipboard clear from the offscreen/background context.
    try {
      // navigator.clipboard isn't available in service workers; use offscreen API
      // when present, otherwise fall back to the active tab's content script.
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]?.id) {
        await chrome.tabs.sendMessage(tabs[0].id, { type: 'CLEAR_CLIPBOARD' }).catch(() => {});
      }
    } catch (e) {
      console.warn('[BYOV] Clipboard clear failed:', e.message);
    }
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'byov_autofill' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_AUTOFILL' });
  }
});

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((err) => {
    sendResponse({ success: false, error: err.message });
  });
  return true; // keep channel open for async response
});

async function handleMessage(message, sender) {
  const { type, payload = {} } = message;

  // Rehydrate session if the worker was evicted between messages.
  // Skip for messages that establish state themselves.
  const noRehydrate = ['CREATE_VAULT', 'UNLOCK_VAULT', 'IMPORT_VAULT',
                       'CLOUD_SIGN_IN', 'CLOUD_SIGN_UP'];
  if (!noRehydrate.includes(type)) {
    await rehydrateSessionIfNeeded();
  }

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
    case 'AUTOFILL_QUERY':       return handleAutofillQuery(payload, sender);
    case 'GET_ITEM_PLAINTEXT':   return handleGetItemPlaintext(payload, sender);
    case 'SCHEDULE_CLIP_CLEAR':  return handleScheduleClipClear(payload);
    case 'CLOUD_SIGN_IN':        return handleCloudSignIn(payload);
    case 'CLOUD_SIGN_UP':        return handleCloudSignUp(payload);
    case 'TEST_STORAGE_PROVIDER': return handleTestStorageProvider(payload);
    case 'GET_PROVIDER_AUTH_STATUS': return handleGetProviderAuthStatus(payload);
    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleCreateVault({ masterPassword, storageType = 'local', storageConfig = {}, userId }) {
  _storageType   = storageType;
  _storageConfig = storageConfig;

  _provider = createProvider(storageType);
  await _provider.connect(storageConfig);
  _userId = await resolveStorageUserId({
    storageType,
    provider: _provider,
    requestedUserId: userId,
    requireAuthenticatedUser: providerRequiresAuthenticatedUser(storageType),
  });

  const deviceId = await getOrCreateDeviceId();
  _vaultHeader = await createVault(masterPassword, deviceId);

  _syncManager = new SyncManager(_provider, _userId, deviceId);

  // Persist empty vault
  await _provider.saveFullVault(_userId, _vaultHeader, []);
  await persistVaultHeader();
  await persistSession();

  scheduleAutoLock();
  return { success: true, userId: _userId };
}

async function handleUnlock({ masterPassword, storageType = 'local', storageConfig = {}, userId }) {
  _storageType   = storageType;
  _storageConfig = storageConfig;
  _provider      = createProvider(storageType);
  await _provider.connect(storageConfig);
  _userId = await resolveStorageUserId({
    storageType,
    provider: _provider,
    requestedUserId: userId,
    requireAuthenticatedUser: providerRequiresAuthenticatedUser(storageType),
  });

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

  await persistSession();
  scheduleAutoLock();
  return { success: true, userId: _userId };
}

async function handleLock() {
  await _handleLock();
  return { success: true };
}

async function _handleLock() {
  lockVault();
  _vaultHeader   = null;
  _syncManager   = null;
  _storageType   = null;
  _storageConfig = null;
  _autofillAuthorizations.clear();
  if (_provider) {
    await _provider.disconnect().catch(() => {});
    _provider = null;
  }
  await chrome.storage.session.remove(SESSION_KEY).catch(() => {});
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
  await persistSession();
  return { success: true, item: encryptedItem };
}

async function handleUpdateItem({ itemId, existingItem, updatedData }) {
  if (!isUnlocked()) throw new Error('Vault is locked');

  // Always look up the canonical encrypted item by id from the in-memory
  // cache. Trusting the popup's copy was a source of duplicate items when
  // the MV3 service worker was evicted + rehydrated between popup load and
  // save: the popup's `existingItem` could lag the rehydrated state.
  const id = itemId || existingItem?.id;
  if (!id) throw new Error('UPDATE_ITEM requires itemId.');

  const canonical = _syncManager._localItems[id];
  if (!canonical) throw new Error(`Item ${id} not found in vault.`);

  const updated = await updateItem(canonical, updatedData);
  await _syncManager.pushItem(updated);
  await persistVaultHeader();
  await persistSession();
  return { success: true, item: updated };
}

async function handleDeleteItem({ itemId }) {
  if (!isUnlocked()) throw new Error('Vault is locked');
  await _syncManager.deleteItem(itemId);
  await persistVaultHeader();
  await persistSession();
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

  _storageType   = storageType;
  _storageConfig = storageConfig;
  _provider      = createProvider(storageType);
  await _provider.connect(storageConfig);
  _userId = await resolveStorageUserId({
    storageType,
    provider: _provider,
    requestedUserId: userId,
    requireAuthenticatedUser: providerRequiresAuthenticatedUser(storageType),
  });

  const deviceId = await getOrCreateDeviceId();
  _vaultHeader = { ...header, device_id: deviceId };

  _syncManager = new SyncManager(_provider, _userId, deviceId);
  for (const item of items) {
    _syncManager._localItems[item.id] = item;
  }

  await _provider.saveFullVault(_userId, _vaultHeader, items);
  await persistSession();
  scheduleAutoLock();
  return { success: true, userId: _userId, itemCount: items.length };
}

async function handleSync() {
  if (!isUnlocked() || !_syncManager) throw new Error('Vault is locked');
  const result = await _syncManager.sync();
  await persistVaultHeader();
  return { success: true, ...result };
}

async function handleChangePassword({ currentMasterPassword, newMasterPassword }) {
  if (!isUnlocked()) throw new Error('Vault is locked');
  if (!currentMasterPassword) throw new Error('Current master password is required.');
  const verified = await verifyMasterPassword(currentMasterPassword, _vaultHeader);
  if (!verified) throw new Error('Current master password is incorrect.');
  _vaultHeader = await changeMasterPassword(newMasterPassword, _vaultHeader);
  await _provider.saveVaultHeader(_userId, _vaultHeader);
  await persistSession();
  return { success: true };
}

async function handleGetItemPlaintext({ itemId, autofillToken }, sender) {
  if (!isUnlocked() || !_syncManager) throw new Error('Vault is locked');
  if (isContentScriptSender(sender)) {
    assertAutofillAccess(sender, itemId, autofillToken);
  } else if (!isExtensionPageSender(sender)) {
    throw new Error('Plaintext item access is only available to trusted extension contexts.');
  }
  const encItem = Object.values(_syncManager._localItems).find((i) => i.id === itemId);
  if (!encItem) throw new Error('Item not found');
  const plaintext = await decryptVaultItem(encItem);
  return { plaintext };
}

async function handleCloudSignIn({ storageType, storageConfig, email, password }) {
  const provider = createProvider(storageType);
  await provider.connect(storageConfig);
  if (typeof provider.signIn !== 'function') {
    throw new Error(`Provider "${storageType}" does not support email/password sign-in.`);
  }
  const data = await provider.signIn(email, password);
  const authInfo = await getAuthenticatedProviderUserInfo(provider);
  const userId = authInfo.id || data?.user?.id || data?.session?.user?.id;
  if (!userId) throw new Error('Sign-in succeeded but no user id returned.');
  return {
    success: true,
    userId,
    userEmail: authInfo.email || data?.user?.email || data?.session?.user?.email || email,
    authenticated: true,
  };
}

async function handleCloudSignUp({ storageType, storageConfig, email, password }) {
  const provider = createProvider(storageType);
  await provider.connect(storageConfig);
  if (typeof provider.signUp !== 'function') {
    throw new Error(`Provider "${storageType}" does not support sign-up.`);
  }
  const data = await provider.signUp(email, password);
  const authInfo = await getAuthenticatedProviderUserInfo(provider);
  const userId = authInfo.id || data?.user?.id || null;
  return {
    success: true,
    userId,
    userEmail: authInfo.email || data?.user?.email || email,
    requiresConfirmation: !data?.session,
    authenticated: Boolean(authInfo.id || data?.session?.user?.id),
  };
}

async function handleTestStorageProvider({ storageType = 'local', storageConfig = {} } = {}) {
  const provider = createProvider(storageType);
  await provider.connect(storageConfig);
  const result = await testStorageProviderConnection(storageType, storageConfig, provider);
  return { success: true, ...result };
}

async function handleGetProviderAuthStatus({ storageType = 'local', storageConfig = {} } = {}) {
  const provider = createProvider(storageType);
  await provider.connect(storageConfig);
  const authInfo = await getAuthenticatedProviderUserInfo(provider);
  return {
    success: true,
    storageType,
    authenticated: Boolean(authInfo.id),
    userId: authInfo.id || null,
    userEmail: authInfo.email || null,
  };
}

async function handleScheduleClipClear({ seconds = 30 } = {}) {
  if (!seconds || seconds <= 0) return { success: true };
  // chrome.alarms minimum is 30s in unpacked dev; round up.
  const minutes = Math.max(seconds / 60, 0.5);
  chrome.alarms.create(ALARM_CLIP_CLEAR, { delayInMinutes: minutes });
  return { success: true };
}

async function handleAutofillQuery(_payload, sender) {
  if (!isUnlocked() || !_syncManager) return { items: [] };
  const senderUrl = getTrustedSenderUrl(sender);
  const pageHostname = normalizeHostname(senderUrl.hostname);
  const authToken = crypto.randomUUID();

  const matches = [];
  for (const encItem of _syncManager.items) {
    if (encItem.type !== 'login') continue;
    try {
      const plain = await decryptVaultItem(encItem);
      if (plain.url && hostnameMatches(plain.url, pageHostname)) {
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

  _autofillAuthorizations.set(getAutofillSenderKey(sender), {
    token: authToken,
    itemIds: new Set(matches.map((item) => item.id)),
    hostname: pageHostname,
    expiresAt: Date.now() + AUTOFILL_AUTH_TTL_MS,
  });

  return { items: matches, autofillToken: authToken };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function persistSession() {
  if (!(await isSessionResumeEnabled())) {
    await chrome.storage.session.remove(SESSION_KEY).catch(() => {});
    return;
  }
  const snap = getSessionSnapshot();
  if (!snap || !_vaultHeader) return;
  const state = {
    vaultKeyB64: bufToBase64(snap.vaultKey),
    kekB64:      bufToBase64(snap.kek),
    deviceId:    snap.deviceId,
    userId:      _userId,
    storageType: _storageType,
    storageConfig: _storageConfig,
    vaultHeader: _vaultHeader,
  };
  try {
    await chrome.storage.session.set({ [SESSION_KEY]: state });
  } catch (e) {
    console.warn('[BYOV] Could not persist session state:', e.message);
  }
}

async function rehydrateSessionIfNeeded() {
  if (!(await isSessionResumeEnabled())) return;
  if (isUnlocked() && _provider && _syncManager) return;
  let state;
  try {
    const res = await chrome.storage.session.get(SESSION_KEY);
    state = res[SESSION_KEY];
  } catch {
    return;
  }
  if (!state) return;

  restoreSession({
    vaultKey: base64ToBuf(state.vaultKeyB64),
    kek:      base64ToBuf(state.kekB64),
    deviceId: state.deviceId,
  });
  _userId        = state.userId;
  _storageType   = state.storageType;
  _storageConfig = state.storageConfig;
  _vaultHeader   = state.vaultHeader;

  _provider = createProvider(_storageType);
  await _provider.connect(_storageConfig || {});

  _syncManager = new SyncManager(_provider, _userId, state.deviceId);
  try {
    const { items } = await _provider.loadFullVault(_userId);
    for (const item of items) _syncManager._localItems[item.id] = item;
  } catch (e) {
    console.warn('[BYOV] Item reload after rehydrate failed:', e.message);
  }
  _syncManager._syncToken = _vaultHeader.sync_token || 'version_0';
}

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
    const itemHost = normalizeHostname(new URL(itemUrl).hostname);
    return itemHost === tabHostname;
  } catch {
    return false;
  }
}

function normalizeHostname(hostname) {
  return hostname.replace(/^www\./i, '').toLowerCase();
}

function getTrustedSenderUrl(sender) {
  if (!isContentScriptSender(sender)) {
    throw new Error('Autofill requests must come from the extension content script.');
  }
  try {
    return new URL(sender.url);
  } catch {
    throw new Error('Invalid sender origin for autofill request.');
  }
}

function isExtensionPageSender(sender) {
  return typeof sender?.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
}

function isContentScriptSender(sender) {
  return Number.isInteger(sender?.tab?.id) && typeof sender?.url === 'string';
}

function getAutofillSenderKey(sender) {
  return `${sender.tab.id}:${sender.frameId ?? 0}`;
}

function assertAutofillAccess(sender, itemId, autofillToken) {
  const key = getAutofillSenderKey(sender);
  const auth = _autofillAuthorizations.get(key);
  if (!auth) {
    throw new Error('Autofill authorisation not found. Trigger autofill again.');
  }
  if (auth.token !== autofillToken) {
    throw new Error('Autofill authorisation token is invalid.');
  }
  if (Date.now() > auth.expiresAt) {
    _autofillAuthorizations.delete(key);
    throw new Error('Autofill authorisation expired. Trigger autofill again.');
  }

  const senderUrl = getTrustedSenderUrl(sender);
  if (normalizeHostname(senderUrl.hostname) !== auth.hostname) {
    _autofillAuthorizations.delete(key);
    throw new Error('Autofill origin mismatch.');
  }
  if (!auth.itemIds.has(itemId)) {
    throw new Error('Requested item is not authorised for this autofill action.');
  }
}

async function getGeneralSettings() {
  const res = await chrome.storage.local.get(GENERAL_SETTINGS_KEY);
  return res[GENERAL_SETTINGS_KEY] || {};
}

async function isSessionResumeEnabled() {
  const settings = await getGeneralSettings();
  return settings.allowSessionResume !== false;
}

async function syncContentScriptRegistration() {
  const settings = await getGeneralSettings();
  const autofillEnabled = settings.autofillEnabled !== false;

  await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] }).catch(() => {});

  if (!autofillEnabled) return;

  await chrome.scripting.registerContentScripts([{
    id: CONTENT_SCRIPT_ID,
    matches: ['https://*/*', 'http://localhost/*'],
    js: ['content/content.js'],
    runAt: 'document_idle',
    allFrames: false,
    persistAcrossSessions: true,
  }]);
}

async function restrictSessionStorageAccess() {
  if (chrome.storage?.session?.setAccessLevel) {
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
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

async function resolveStorageUserId({
  storageType,
  provider,
  requestedUserId,
  requireAuthenticatedUser = false,
}) {
  const authenticatedUserId = await getAuthenticatedProviderUserId(provider);
  if (authenticatedUserId) {
    return authenticatedUserId;
  }

  if (requireAuthenticatedUser) {
    const providerName = provider?.name || storageType;
    throw new Error(`${providerName} sign-in is required before using this storage provider.`);
  }

  return requestedUserId || uuidv4();
}

async function getAuthenticatedProviderUserId(provider) {
  const info = await getAuthenticatedProviderUserInfo(provider);
  return info.id;
}

async function getAuthenticatedProviderUserInfo(provider) {
  if (typeof provider?.getCurrentUser !== 'function') {
    return { id: null, email: null };
  }

  try {
    const user = await provider.getCurrentUser();
    return {
      id: user?.id || user?.uid || null,
      email: user?.email || null,
    };
  } catch {
    return { id: null, email: null };
  }
}

function providerRequiresAuthenticatedUser(storageType) {
  return storageType === 'supabase' || storageType === 'firebase';
}

async function testStorageProviderConnection(storageType, storageConfig, provider) {
  switch (storageType) {
    case 'local':
      return testLocalStorageProvider();
    case 'supabase':
      return testSupabaseProvider(storageConfig, provider);
    case 'firebase':
      return testFirebaseProvider(provider);
    case 'onedrive':
      return testOAuthProviderConfig('OneDrive', storageConfig.clientId, storageConfig.redirectUri);
    case 'googledrive':
      return testOAuthProviderConfig('Google Drive', storageConfig.clientId, storageConfig.redirectUri);
    case 'dropbox':
      return testOAuthProviderConfig('Dropbox', storageConfig.clientId, storageConfig.redirectUri);
    default:
      return {
        storageType,
        authenticated: false,
        message: 'Configuration loaded.',
      };
  }
}

async function testLocalStorageProvider() {
  const probeKey = `byov_storage_probe_${crypto.randomUUID()}`;
  await chrome.storage.local.set({ [probeKey]: 'ok' });
  const result = await chrome.storage.local.get(probeKey);
  await chrome.storage.local.remove(probeKey);
  if (result[probeKey] !== 'ok') {
    throw new Error('Local extension storage did not return the expected test value.');
  }
  return {
    storageType: 'local',
    authenticated: true,
    message: 'Local extension storage is working normally on this device.',
  };
}

async function testSupabaseProvider(storageConfig, provider) {
  const { supabaseUrl, supabaseAnonKey } = storageConfig;
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase URL and anon key are required.');
  }

  const response = await fetch(`${supabaseUrl}/rest/v1/vault_headers?select=user_id&limit=1`, {
    headers: {
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`,
    },
  });

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const errorBody = await response.json();
      detail = errorBody.message || errorBody.error_description || errorBody.error || detail;
    } catch {}
    throw new Error(`Supabase test request failed: ${detail}`);
  }

  const authInfo = await getAuthenticatedProviderUserInfo(provider);
  return {
    storageType: 'supabase',
    authenticated: Boolean(authInfo.id),
    userId: authInfo.id || null,
    userEmail: authInfo.email || null,
    message: authInfo.id
      ? `Supabase is reachable and signed in as ${authInfo.email || authInfo.id}.`
      : 'Supabase is reachable. Sign in with your Supabase account before creating or unlocking the vault.',
  };
}

async function testFirebaseProvider(provider) {
  const authInfo = await getAuthenticatedProviderUserInfo(provider);
  return {
    storageType: 'firebase',
    authenticated: Boolean(authInfo.id),
    userId: authInfo.id || null,
    userEmail: authInfo.email || null,
    message: authInfo.id
      ? `Firebase is configured and signed in as ${authInfo.email || authInfo.id}.`
      : 'Firebase configuration loaded. Sign in with your Firebase Auth account to fully validate storage access.',
  };
}

function testOAuthProviderConfig(providerName, clientId, redirectUri) {
  if (!clientId) {
    throw new Error(`${providerName} requires a client id/app key before it can be tested.`);
  }

  if (providerName !== 'OneDrive' && !redirectUri) {
    throw new Error(`${providerName} requires a redirect URI before OAuth can be tested.`);
  }

  return {
    storageType: providerName.toLowerCase(),
    authenticated: false,
    message: redirectUri
      ? `${providerName} configuration looks valid. Complete the OAuth sign-in flow to finish setup.`
      : `${providerName} client id looks valid. Add the redirect URI shown by your OAuth app registration before testing sign-in.`,
  };
}

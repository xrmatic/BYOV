/**
 * BYOV Options Page Script
 *
 * Manages settings persistence and storage provider configuration.
 * All settings are stored in chrome.storage.local (not synced, to avoid
 * leaking provider credentials via Chrome Sync).
 */

import './options.css';

const STORAGE_SETTINGS_KEY = 'byov_storage_settings';
const PROVIDER_HEALTH_KEY = 'byov_provider_health';
const USER_IDS_KEY = 'byov_user_ids';
const PROVIDER_DOC_URLS = {
  firebase: 'https://firebase.google.com/docs/web/setup',
  supabase: 'https://supabase.com/docs/guides/getting-started',
  onedrive: 'https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app',
  googledrive: 'https://developers.google.com/drive/api/quickstart/js',
  dropbox: 'https://www.dropbox.com/developers/documentation/http/documentation',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function showStatus(elId, type, msg) {
  const el = $(elId);
  if (!el) return;
  el.textContent = msg;
  el.className = `status-msg ${type}`;
}

function hideStatus(elId) {
  const el = $(elId);
  if (el) el.className = 'status-msg hidden';
}

async function saveSettings(key, data) {
  await chrome.storage.local.set({ [key]: data });
}

async function loadSettings(key) {
  const res = await chrome.storage.local.get(key);
  return res[key] || {};
}

async function sendMsg(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, payload });
}

function downloadFile(content, filename) {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Initialisation ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  setupLockedState();
  const unlocked = await refreshVaultStatus();
  if (!unlocked) return;
  await initializeSettingsPage();
});

async function initializeSettingsPage() {
  setupNavigation();
  await loadGeneralSettings();
  await loadStorageSettings();
  await loadDeviceId();
  setupGeneralSection();
  setupStorageSection();
  setupSecuritySection();
  setupImportExportSection();
}

// ─── Navigation ───────────────────────────────────────────────────────────────

function setupNavigation() {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
      btn.classList.add('active');
      const section = $(`section-${btn.dataset.section}`);
      if (section) section.classList.add('active');
    });
  });
}

// ─── General Settings ─────────────────────────────────────────────────────────

async function loadGeneralSettings() {
  const settings = await loadSettings('byov_general_settings');
  if (settings.autoLockMinutes !== undefined) {
    setValue('auto-lock-minutes', settings.autoLockMinutes);
  }
  if (settings.autofillEnabled !== undefined) {
    $('autofill-enabled').checked = settings.autofillEnabled;
  }
  if (settings.autofillIcon !== undefined) {
    $('autofill-icon').checked = settings.autofillIcon;
  }
  if (settings.clipboardClear !== undefined) {
    setValue('clipboard-clear', settings.clipboardClear);
  }
  if (settings.allowSessionResume !== undefined) {
    $('allow-session-resume').checked = settings.allowSessionResume;
  } else if ($('allow-session-resume')) {
    $('allow-session-resume').checked = true;
  }
}

function setupGeneralSection() {
  $('btn-save-general')?.addEventListener('click', async () => {
    const settings = {
      autoLockMinutes: parseInt($('auto-lock-minutes')?.value || '15', 10),
      autofillEnabled: $('autofill-enabled')?.checked ?? true,
      autofillIcon:    $('autofill-icon')?.checked ?? true,
      clipboardClear:  parseInt($('clipboard-clear')?.value || '30', 10),
      allowSessionResume: $('allow-session-resume')?.checked ?? true,
    };

    await saveSettings('byov_general_settings', settings);
    // Also save auto-lock minutes separately for the background worker
    await chrome.storage.local.set({ byov_auto_lock_minutes: settings.autoLockMinutes });

    showStatus('general-status', 'success', '✓ General settings saved.');
    setTimeout(() => hideStatus('general-status'), 3000);
  });
}

// ─── Storage Settings ─────────────────────────────────────────────────────────

async function loadStorageSettings() {
  const settings = await loadSettings(STORAGE_SETTINGS_KEY);
  if (settings.storageType) {
    setValue('storage-type', settings.storageType);
    showProviderConfig(settings.storageType);
  } else {
    showProviderConfig('local');
  }

  // Populate provider-specific fields
  if (settings.firebase) {
    setValue('fb-api-key',            settings.firebase.apiKey || '');
    setValue('fb-auth-domain',        settings.firebase.authDomain || '');
    setValue('fb-project-id',         settings.firebase.projectId || '');
    setValue('fb-storage-bucket',     settings.firebase.storageBucket || '');
    setValue('fb-messaging-sender-id',settings.firebase.messagingSenderId || '');
    setValue('fb-app-id',             settings.firebase.appId || '');
  }
  if (settings.supabase) {
    setValue('sb-url',      settings.supabase.supabaseUrl  || '');
    setValue('sb-anon-key', settings.supabase.supabaseAnonKey || '');
  }
  if (settings.onedrive) {
    setValue('od-client-id', settings.onedrive.clientId || '');
    setValue('od-tenant-id', settings.onedrive.tenantId || 'common');
    setValue('od-redirect-uri', settings.onedrive.redirectUri || '');
  }
  if (settings.googledrive) {
    setValue('gd-client-id', settings.googledrive.clientId || '');
    setValue('gd-redirect-uri', settings.googledrive.redirectUri || '');
  }
  if (settings.dropbox) {
    setValue('dbx-client-id', settings.dropbox.clientId || '');
    setValue('dbx-redirect-uri', settings.dropbox.redirectUri || '');
  }
  await loadLocalVaultSummary(settings.storageType || 'local');
}

function setupStorageSection() {
  $('storage-type')?.addEventListener('change', (e) => {
    showProviderConfig(e.target.value);
    loadLocalVaultSummary(e.target.value).catch(() => {});
  });

  $('btn-save-storage')?.addEventListener('click', async () => {
    hideStatus('storage-status');
    const previous = await loadSettings(STORAGE_SETTINGS_KEY);
    const settings = getStorageSettingsFromForm();
    const storageType = settings.storageType;

    await saveSettings(STORAGE_SETTINGS_KEY, settings);
    await resetProviderHealthForConfigChanges(previous, settings);
    await loadLocalVaultSummary(storageType);
    showStatus('storage-status', 'success', '✓ Storage settings saved. Reload the extension to apply.');
    setTimeout(() => hideStatus('storage-status'), 4000);
  });

  $('btn-create-local-vault')?.addEventListener('click', async () => {
    hideStatus('local-vault-status');
    const password = $('local-create-password')?.value || '';
    const confirm = $('local-create-confirm')?.value || '';

    if (!password) {
      showStatus('local-vault-status', 'error', 'Master password is required.');
      return;
    }
    if (password !== confirm) {
      showStatus('local-vault-status', 'error', 'Passwords do not match.');
      return;
    }

    try {
      const res = await sendMsg('CREATE_VAULT', {
        masterPassword: password,
        storageType: 'local',
        storageConfig: {},
      });
      if (res?.success) {
        await storeUserId('local', res.userId);
        await markProviderVerified('local');
        $('local-create-password').value = '';
        $('local-create-confirm').value = '';
        await loadLocalVaultSummary('local');
        showStatus('local-vault-status', 'success', '✓ Local vault created successfully.');
      } else {
        showStatus('local-vault-status', 'error', res?.error || 'Failed to create local vault.');
      }
    } catch (err) {
      showStatus('local-vault-status', 'error', err.message || 'Failed to create local vault.');
    }
  });

  // OAuth button handlers
  $('btn-auth-onedrive')?.addEventListener('click', () => {
    showStatus('od-auth-status', 'success', 'OAuth wiring is not fully implemented yet. Use Test Configuration and the setup guide to validate your app registration details.');
  });

  $('btn-auth-googledrive')?.addEventListener('click', () => {
    showStatus('gd-auth-status', 'success', 'OAuth wiring is not fully implemented yet. Use Test Configuration and the setup guide to validate your Google Drive app settings.');
  });

  $('btn-auth-dropbox')?.addEventListener('click', () => {
    showStatus('dbx-auth-status', 'success', 'OAuth wiring is not fully implemented yet. Use Test Configuration and the setup guide to validate your Dropbox app settings.');
  });

  $('btn-test-local')?.addEventListener('click', () => testProviderConnection('local', 'local-test-status'));
  $('btn-test-firebase')?.addEventListener('click', () => testProviderConnection('firebase', 'firebase-status'));
  $('btn-test-supabase')?.addEventListener('click', () => testProviderConnection('supabase', 'supabase-status'));
  $('btn-test-onedrive')?.addEventListener('click', () => testProviderConnection('onedrive', 'od-auth-status'));
  $('btn-test-googledrive')?.addEventListener('click', () => testProviderConnection('googledrive', 'gd-auth-status'));
  $('btn-test-dropbox')?.addEventListener('click', () => testProviderConnection('dropbox', 'dbx-auth-status'));

  $('btn-sign-in-firebase')?.addEventListener('click', () => authenticateProvider('firebase', 'CLOUD_SIGN_IN', 'firebase-status'));
  $('btn-sign-up-firebase')?.addEventListener('click', () => authenticateProvider('firebase', 'CLOUD_SIGN_UP', 'firebase-status'));
  $('btn-sign-in-supabase')?.addEventListener('click', () => authenticateProvider('supabase', 'CLOUD_SIGN_IN', 'supabase-status'));
  $('btn-sign-up-supabase')?.addEventListener('click', () => authenticateProvider('supabase', 'CLOUD_SIGN_UP', 'supabase-status'));

  $('btn-open-firebase-docs')?.addEventListener('click', () => openExternalUrl(PROVIDER_DOC_URLS.firebase));
  $('btn-open-supabase-docs')?.addEventListener('click', () => openExternalUrl(PROVIDER_DOC_URLS.supabase));
  $('btn-open-onedrive-docs')?.addEventListener('click', () => openExternalUrl(PROVIDER_DOC_URLS.onedrive));
  $('btn-open-googledrive-docs')?.addEventListener('click', () => openExternalUrl(PROVIDER_DOC_URLS.googledrive));
  $('btn-open-dropbox-docs')?.addEventListener('click', () => openExternalUrl(PROVIDER_DOC_URLS.dropbox));
}

function showProviderConfig(type) {
  document.querySelectorAll('.provider-config').forEach((el) => el.classList.add('hidden'));
  $(`config-${type}`)?.classList.remove('hidden');
}

function getStorageSettingsFromForm() {
  return {
    storageType: $('storage-type')?.value || 'local',
    firebase: {
      apiKey: $('fb-api-key')?.value || '',
      authDomain: $('fb-auth-domain')?.value || '',
      projectId: $('fb-project-id')?.value || '',
      storageBucket: $('fb-storage-bucket')?.value || '',
      messagingSenderId: $('fb-messaging-sender-id')?.value || '',
      appId: $('fb-app-id')?.value || '',
    },
    supabase: {
      supabaseUrl: $('sb-url')?.value || '',
      supabaseAnonKey: $('sb-anon-key')?.value || '',
    },
    onedrive: {
      clientId: $('od-client-id')?.value || '',
      tenantId: $('od-tenant-id')?.value || 'common',
      redirectUri: $('od-redirect-uri')?.value || '',
    },
    googledrive: {
      clientId: $('gd-client-id')?.value || '',
      redirectUri: $('gd-redirect-uri')?.value || '',
    },
    dropbox: {
      clientId: $('dbx-client-id')?.value || '',
      redirectUri: $('dbx-redirect-uri')?.value || '',
    },
  };
}

function getProviderConfig(storageType) {
  const settings = getStorageSettingsFromForm();
  return settings[storageType] || {};
}

async function testProviderConnection(storageType, statusId) {
  hideStatus(statusId);
  try {
    const res = await sendMsg('TEST_STORAGE_PROVIDER', {
      storageType,
      storageConfig: getProviderConfig(storageType),
    });

    if (res?.success) {
      if (res.userId) {
        await storeUserId(storageType, res.userId);
      }
      if (res.authenticated || storageType === 'local') {
        await markProviderVerified(storageType);
      }
      showStatus(statusId, 'success', res.message || 'Connection test passed.');
    } else {
      showStatus(statusId, 'error', res?.error || 'Connection test failed.');
    }
  } catch (err) {
    showStatus(statusId, 'error', err.message || 'Connection test failed.');
  }
}

async function authenticateProvider(storageType, actionType, statusId) {
  hideStatus(statusId);
  const email = $(`${storageType === 'supabase' ? 'sb' : 'fb'}-email`)?.value?.trim() || '';
  const password = $(`${storageType === 'supabase' ? 'sb' : 'fb'}-password`)?.value || '';

  if (!email || !password) {
    showStatus(statusId, 'error', 'Enter the provider account email and password first.');
    return;
  }

  try {
    const res = await sendMsg(actionType, {
      storageType,
      storageConfig: getProviderConfig(storageType),
      email,
      password,
    });

    if (!res?.success) {
      showStatus(statusId, 'error', res?.error || 'Provider authentication failed.');
      return;
    }

    if (res.userId) {
      await storeUserId(storageType, res.userId);
    }

    const providerLabel = storageType === 'supabase' ? 'Supabase' : 'Firebase';
    const message = actionType === 'CLOUD_SIGN_UP'
      ? (res.requiresConfirmation
        ? `${providerLabel} account created. Confirm the email if required, then sign in.`
        : `${providerLabel} account created and ready.`)
      : `${providerLabel} signed in as ${res.userEmail || res.userId || email}.`;

    showStatus(statusId, 'success', message);
  } catch (err) {
    showStatus(statusId, 'error', err.message || 'Provider authentication failed.');
  }
}

function openExternalUrl(url) {
  chrome.tabs.create({ url });
}

// ─── Security Settings ────────────────────────────────────────────────────────

function setupSecuritySection() {
  $('btn-change-password')?.addEventListener('click', async () => {
    hideStatus('change-pw-status');
    const newPassword = $('change-new-password')?.value || '';
    const confirm     = $('change-confirm-password')?.value || '';

    if (!newPassword) {
      showStatus('change-pw-status', 'error', 'New password is required.');
      return;
    }
    if (newPassword !== confirm) {
      showStatus('change-pw-status', 'error', 'Passwords do not match.');
      return;
    }

    try {
      const currentPassword = $('change-current-password')?.value || '';
      if (!currentPassword) {
        showStatus('change-pw-status', 'error', 'Current master password is required.');
        return;
      }

      const res = await sendMsg('CHANGE_PASSWORD', {
        currentMasterPassword: currentPassword,
        newMasterPassword: newPassword,
      });
      if (res?.success) {
        showStatus('change-pw-status', 'success', '✓ Master password changed successfully.');
        $('change-new-password').value = '';
        $('change-confirm-password').value = '';
        $('change-current-password').value = '';
      } else {
        showStatus('change-pw-status', 'error', res?.error || 'Failed to change password. Is the vault unlocked?');
      }
    } catch (err) {
      showStatus('change-pw-status', 'error', err.message || 'Failed to change password.');
    }
  });
}

// ─── Import / Export ──────────────────────────────────────────────────────────

function setupImportExportSection() {
  $('btn-export-vault')?.addEventListener('click', async () => {
    hideStatus('export-status');
    try {
      const res = await sendMsg('EXPORT_VAULT');
      if (res?.json) {
        const date = new Date().toISOString().slice(0, 10);
        downloadFile(res.json, `vault-backup-${date}.byov`);
        showStatus('export-status', 'success', '✓ Vault exported successfully.');
      } else {
        showStatus('export-status', 'error', res?.error || 'Export failed. Is the vault unlocked?');
      }
    } catch (err) {
      showStatus('export-status', 'error', err.message || 'Export failed.');
    }
  });

  $('btn-import-vault')?.addEventListener('click', async () => {
    hideStatus('import-export-status');
    const file     = $('import-vault-file')?.files?.[0];
    const password = $('import-vault-password')?.value || '';

    if (!file)     { showStatus('import-export-status', 'error', 'Please select a .byov file.'); return; }
    if (!password) { showStatus('import-export-status', 'error', 'Master password is required.'); return; }

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const storageSettings = await loadSettings(STORAGE_SETTINGS_KEY);
        const storageType   = storageSettings.storageType || 'local';
        const storageConfig = storageSettings[storageType] || {};
        const res = await sendMsg('IMPORT_VAULT', {
          jsonString:    e.target.result,
          masterPassword: password,
          storageType,
          storageConfig,
          userId: await getStoredUserId(storageType),
        });
        if (res?.success) {
          await storeUserId(storageType, res.userId);
          await markProviderVerified(storageType);
          showStatus('import-export-status', 'success', `✓ Imported ${res.itemCount} items. Refreshing Settings shortly…`);
          startRefreshCountdown(5);
        } else {
          showStatus('import-export-status', 'error', res?.error || 'Import failed.');
        }
      } catch (err) {
        showStatus('import-export-status', 'error', err.message || 'Import failed.');
      }
    };
    reader.readAsText(file);
  });
}

// ─── Device ID ────────────────────────────────────────────────────────────────

async function loadDeviceId() {
  const res = await chrome.storage.local.get('byov_device_id');
  const el = $('device-id-display');
  if (el) el.textContent = res.byov_device_id || '(not set yet – unlock the vault first)';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setValue(id, val) {
  const el = $(id);
  if (el) el.value = val;
}

function setupLockedState() {
  $('btn-open-popup-tab')?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') });
  });

  $('btn-refresh-status')?.addEventListener('click', async () => {
    const unlocked = await refreshVaultStatus();
    if (unlocked) {
      window.location.reload();
    } else {
      showStatus('locked-status', 'error', 'Vault is still locked. Unlock it from the BYOV popup first.');
    }
  });
}

async function refreshVaultStatus() {
  const status = await sendMsg('GET_STATUS');
  const unlocked = status?.unlocked === true;
  $('locked-state')?.classList.toggle('hidden', unlocked);
  document.querySelector('.container')?.classList.toggle('hidden', !unlocked);
  return unlocked;
}

async function resetProviderHealthForConfigChanges(previous, next) {
  const health = await loadSettings(PROVIDER_HEALTH_KEY);

  for (const key of ['firebase', 'supabase', 'onedrive', 'googledrive', 'dropbox']) {
    if (JSON.stringify(previous[key] || {}) !== JSON.stringify(next[key] || {})) {
      health[key] = {
        ...(health[key] || {}),
        working: false,
        lastInvalidatedAt: new Date().toISOString(),
      };
    }
  }

  health.local = { ...(health.local || {}), working: true };
  await saveSettings(PROVIDER_HEALTH_KEY, health);
}

async function markProviderVerified(storageType) {
  const health = await loadSettings(PROVIDER_HEALTH_KEY);
  health[storageType] = {
    ...(health[storageType] || {}),
    working: true,
    lastSuccessAt: new Date().toISOString(),
  };
  await saveSettings(PROVIDER_HEALTH_KEY, health);
}

async function loadLocalVaultSummary(activeStorageType) {
  const container = $('local-vault-summary');
  if (!container) return;

  if (activeStorageType !== 'local') {
    container.innerHTML = '<p class="hint">Local vault details are shown when Local Device is the active storage provider.</p>';
    return;
  }

  const userId = await getStoredUserId('local');
  if (!userId) {
    container.innerHTML = '<p class="hint">No local vault detected for this browser profile yet.</p>';
    return;
  }

  const headerKey = `byov_header_${userId}`;
  const itemsKey = `byov_items_${userId}`;
  const vault = await chrome.storage.local.get([headerKey, itemsKey]);
  const header = vault[headerKey];
  const itemsMap = vault[itemsKey] || {};
  const items = Object.values(itemsMap).filter((item) => !item.deleted);

  if (!header) {
    container.innerHTML = '<p class="hint">No local vault detected for this browser profile yet.</p>';
    return;
  }

  container.innerHTML = `
    <div class="vault-summary-grid">
      ${summaryCard('Vault ID', userId)}
      ${summaryCard('Items', String(items.length))}
      ${summaryCard('Created', formatDateTime(header.created_at))}
      ${summaryCard('Last Updated', formatDateTime(header.updated_at))}
      ${summaryCard('Device ID', header.device_id || 'Unknown')}
      ${summaryCard('Sync Token', header.sync_token || 'version_0')}
    </div>
  `;
}

function summaryCard(label, value) {
  return `
    <div class="vault-summary-card">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(value || 'Unknown')}</span>
    </div>
  `;
}

function formatDateTime(iso) {
  if (!iso) return 'Unknown';
  return new Date(iso).toLocaleString();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function startRefreshCountdown(seconds) {
  const modal = $('refresh-countdown-modal');
  const text = $('refresh-countdown-text');
  if (!modal || !text) {
    setTimeout(() => window.location.reload(), seconds * 1000);
    return;
  }

  modal.classList.remove('hidden');
  let remaining = seconds;
  text.textContent = `Refreshing this page in ${remaining} seconds…`;

  const timer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(timer);
      text.textContent = 'Refreshing now…';
      window.location.reload();
      return;
    }
    text.textContent = `Refreshing this page in ${remaining} seconds…`;
  }, 1000);
}

async function getStoredUserIds() {
  const res = await chrome.storage.local.get([USER_IDS_KEY, 'byov_user_id']);
  const userIds = res[USER_IDS_KEY] || {};
  if (!userIds.local && res.byov_user_id) {
    userIds.local = res.byov_user_id;
  }
  return userIds;
}

async function getStoredUserId(storageType = 'local') {
  const userIds = await getStoredUserIds();
  return userIds[storageType] || null;
}

async function storeUserId(storageType, userId) {
  if (!storageType || !userId) return;
  const userIds = await getStoredUserIds();
  userIds[storageType] = userId;

  const payload = { [USER_IDS_KEY]: userIds };
  if (storageType === 'local') {
    payload.byov_user_id = userId;
  }
  await chrome.storage.local.set(payload);
}

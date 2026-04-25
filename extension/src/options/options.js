/**
 * BYOV Options Page Script
 *
 * Manages settings persistence and storage provider configuration.
 * All settings are stored in chrome.storage.local (not synced, to avoid
 * leaking provider credentials via Chrome Sync).
 */

import './options.css';

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
  setupNavigation();
  await loadGeneralSettings();
  await loadStorageSettings();
  await loadDeviceId();
  setupGeneralSection();
  setupStorageSection();
  setupSecuritySection();
  setupImportExportSection();
});

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
}

function setupGeneralSection() {
  $('btn-save-general')?.addEventListener('click', async () => {
    const settings = {
      autoLockMinutes: parseInt($('auto-lock-minutes')?.value || '15', 10),
      autofillEnabled: $('autofill-enabled')?.checked ?? true,
      autofillIcon:    $('autofill-icon')?.checked ?? true,
      clipboardClear:  parseInt($('clipboard-clear')?.value || '30', 10),
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
  const settings = await loadSettings('byov_storage_settings');
  if (settings.storageType) {
    setValue('storage-type', settings.storageType);
    showProviderConfig(settings.storageType);
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
    setValue('sb-api-url',  settings.supabase.apiUrl || '');
  }
  if (settings.onedrive) {
    setValue('od-client-id', settings.onedrive.clientId || '');
    setValue('od-tenant-id', settings.onedrive.tenantId || 'common');
  }
  if (settings.googledrive) {
    setValue('gd-client-id', settings.googledrive.clientId || '');
  }
  if (settings.dropbox) {
    setValue('dbx-client-id', settings.dropbox.clientId || '');
  }
}

function setupStorageSection() {
  $('storage-type')?.addEventListener('change', (e) => {
    showProviderConfig(e.target.value);
  });

  $('btn-save-storage')?.addEventListener('click', async () => {
    hideStatus('storage-status');
    const storageType = $('storage-type')?.value || 'local';
    const settings = {
      storageType,
      firebase: {
        apiKey:            $('fb-api-key')?.value || '',
        authDomain:        $('fb-auth-domain')?.value || '',
        projectId:         $('fb-project-id')?.value || '',
        storageBucket:     $('fb-storage-bucket')?.value || '',
        messagingSenderId: $('fb-messaging-sender-id')?.value || '',
        appId:             $('fb-app-id')?.value || '',
      },
      supabase: {
        supabaseUrl:     $('sb-url')?.value || '',
        supabaseAnonKey: $('sb-anon-key')?.value || '',
        apiUrl:          $('sb-api-url')?.value || '',
      },
      onedrive: {
        clientId: $('od-client-id')?.value || '',
        tenantId: $('od-tenant-id')?.value || 'common',
      },
      googledrive: {
        clientId: $('gd-client-id')?.value || '',
      },
      dropbox: {
        clientId: $('dbx-client-id')?.value || '',
      },
    };

    await saveSettings('byov_storage_settings', settings);
    showStatus('storage-status', 'success', '✓ Storage settings saved. Reload the extension to apply.');
    setTimeout(() => hideStatus('storage-status'), 4000);
  });

  // OAuth button handlers
  $('btn-auth-onedrive')?.addEventListener('click', () => {
    showStatus('od-auth-status', 'success', 'OAuth flow would open here. Configure redirect URI in Azure Portal first.');
  });

  $('btn-auth-googledrive')?.addEventListener('click', () => {
    showStatus('gd-auth-status', 'success', 'OAuth flow would open here. Configure redirect URI in Google Cloud Console first.');
  });

  $('btn-auth-dropbox')?.addEventListener('click', () => {
    showStatus('dbx-auth-status', 'success', 'OAuth flow would open here. Configure redirect URI in Dropbox App Console first.');
  });
}

function showProviderConfig(type) {
  document.querySelectorAll('.provider-config').forEach((el) => el.classList.add('hidden'));
  $(`config-${type}`)?.classList.remove('hidden');
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
      const res = await sendMsg('CHANGE_PASSWORD', { newMasterPassword: newPassword });
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
    hideStatus('import-export-status');
    try {
      const res = await sendMsg('EXPORT_VAULT');
      if (res?.json) {
        const date = new Date().toISOString().slice(0, 10);
        downloadFile(res.json, `vault-backup-${date}.byov`);
        showStatus('import-export-status', 'success', '✓ Vault exported successfully.');
      } else {
        showStatus('import-export-status', 'error', res?.error || 'Export failed. Is the vault unlocked?');
      }
    } catch (err) {
      showStatus('import-export-status', 'error', err.message || 'Export failed.');
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
        const storageSettings = await loadSettings('byov_storage_settings');
        const storageType   = storageSettings.storageType || 'local';
        const storageConfig = storageSettings[storageType] || {};
        const res = await sendMsg('IMPORT_VAULT', {
          jsonString:    e.target.result,
          masterPassword: password,
          storageType,
          storageConfig,
        });
        if (res?.success) {
          await chrome.storage.local.set({ byov_user_id: res.userId });
          showStatus('import-export-status', 'success', `✓ Imported ${res.itemCount} items. Reopen the extension popup.`);
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

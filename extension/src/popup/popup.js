/**
 * BYOV Popup Script
 *
 * Manages all popup UI interactions, delegating all crypto/storage work to the
 * background service worker via chrome.runtime.sendMessage.
 */

import './popup.css';

// ─── State ────────────────────────────────────────────────────────────────────

let _currentItems    = [];   // array of EncryptedItem (from background)
let _activeFilter    = 'all';
let _searchQuery     = '';
let _sortMode        = 'updated_desc';
let _editingItemId   = null; // null = new item, string = editing existing

const STORAGE_SETTINGS_KEY = 'byov_storage_settings';
const PROVIDER_HEALTH_KEY = 'byov_provider_health';
const USER_IDS_KEY = 'byov_user_ids';
const CLOUD_AUTH_STORAGE_TYPES = new Set(['firebase', 'supabase']);

const STORAGE_PROVIDERS = {
  local: {
    label: 'Local Device',
    isReady: () => true,
  },
  firebase: {
    label: 'Firebase',
    isReady: (config = {}) => Boolean(
      config.apiKey && config.authDomain && config.projectId && config.appId,
    ),
  },
  supabase: {
    label: 'Supabase Sync',
    isReady: (config = {}) => Boolean(config.supabaseUrl && config.supabaseAnonKey),
  },
  onedrive: {
    label: 'OneDrive',
    isReady: (config = {}) => Boolean(config.clientId),
  },
  googledrive: {
    label: 'Google Drive',
    isReady: (config = {}) => Boolean(config.clientId),
  },
  dropbox: {
    label: 'Dropbox',
    isReady: (config = {}) => Boolean(config.clientId),
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function showScreen(name) {
  // Reset any in-flight button loading state — prevents the stale "Working…"
  // text from sticking on a button when navigating mid-operation.
  document.querySelectorAll('button[data-orig-text], button.loading').forEach((btn) => {
    if (btn.dataset.origText) {
      btn.textContent = btn.dataset.origText;
      delete btn.dataset.origText;
    }
    btn.disabled = false;
    btn.classList.remove('loading');
  });

  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  const screen = $(`screen-${name}`);
  if (screen) screen.classList.add('active');
}

function showError(elId, msg) {
  const el = $(elId);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden', 'success-msg');
  el.classList.add('error-msg');
}

function showSuccess(elId, msg) {
  const el = $(elId);
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden', 'error-msg');
  el.classList.add('success-msg');
}

function clearMsg(elId) {
  const el = $(elId);
  if (el) { el.textContent = ''; el.classList.add('hidden'); }
}

function setLoading(btnId, loading) {
  const btn = $(btnId);
  if (!btn) return;
  if (loading) {
    if (!btn.dataset.origText) btn.dataset.origText = btn.textContent;
    btn.innerHTML = '<span class="spinner"></span> Working…';
    btn.disabled = true;
    btn.classList.add('loading');
  } else {
    if (btn.dataset.origText) btn.textContent = btn.dataset.origText;
    delete btn.dataset.origText;
    btn.disabled = false;
    btn.classList.remove('loading');
  }
}

async function sendMsg(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, payload });
}

function downloadFile(content, filename, mimeType = 'application/json') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Secure password generator */
function generatePassword(length = 20, opts = {}) {
  const { upper = true, lower = true, digits = true, symbols = true } = opts;
  let charset = '';
  if (upper)   charset += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (lower)   charset += 'abcdefghijklmnopqrstuvwxyz';
  if (digits)  charset += '0123456789';
  if (symbols) charset += '!@#$%^&*()-_=+[]{}|;:,.<>?';
  if (!charset) charset = 'abcdefghijklmnopqrstuvwxyz';

  const buf = new Uint32Array(length);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((n) => charset[n % charset.length])
    .join('');
}

/** Very rough password strength scorer (0-4) */
function scorePassword(pwd) {
  let score = 0;
  if (pwd.length >= 8)  score++;
  if (pwd.length >= 14) score++;
  if (/[A-Z]/.test(pwd) && /[a-z]/.test(pwd)) score++;
  if (/\d/.test(pwd)) score++;
  if (/[^A-Za-z0-9]/.test(pwd)) score++;
  return Math.min(score, 4);
}

const STRENGTH_COLORS = ['#f38ba8', '#fab387', '#f9e2af', '#a6e3a1', '#94e2d5'];
const STRENGTH_LABELS = ['Very Weak', 'Weak', 'Fair', 'Strong', 'Very Strong'];

function updateStrengthMeter(password) {
  const meter = $('strength-meter');
  if (!meter) return;
  const score = scorePassword(password);
  meter.style.setProperty('--strength', `${(score / 4) * 100}%`);
  meter.style.setProperty('--strength-color', STRENGTH_COLORS[score]);
  meter.title = STRENGTH_LABELS[score];
}

function itemTypeIcon(type) {
  const icons = { login: '🔑', note: '📝', card: '💳', identity: '🪪' };
  return icons[type] || '🔐';
}

function itemTypeLabel(type) {
  const labels = { login: 'Login', note: 'Secure Note', card: 'Credit Card', identity: 'Identity' };
  return labels[type] || 'Item';
}

// ─── Initialisation ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await populateStorageOptions();
  setupAuthScreen();
  setupVaultScreen();
  setupItemScreen();
  setupPasswordGenerator();
  setupImportExport();

  // Determine initial screen
  const status = await sendMsg('GET_STATUS');
  if (status?.unlocked) {
    await loadAndShowVault();
  } else {
    showScreen('auth');
  }
});

// ─── Auth Screen ──────────────────────────────────────────────────────────────

function setupAuthScreen() {
  // Tab switching
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      const content = document.querySelector(`.tab-content[data-tab="${tab}"]`);
      if (content) content.classList.add('active');
      updateCloudAuthPanel('unlock');
      updateCloudAuthPanel('create');
    });
  });

  // Toggle password visibility
  document.querySelectorAll('.toggle-pw').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = $(btn.dataset.target);
      if (!target) return;
      target.type = target.type === 'password' ? 'text' : 'password';
      btn.textContent = target.type === 'password' ? '👁' : '🙈';
    });
  });

  // Password strength meter
  const createPw = $('create-password');
  if (createPw) {
    createPw.addEventListener('input', () => updateStrengthMeter(createPw.value));
  }

  $('unlock-storage')?.addEventListener('change', () => updateCloudAuthPanel('unlock'));
  $('create-storage')?.addEventListener('change', () => updateCloudAuthPanel('create'));

  $('btn-unlock-cloud-sign-in')?.addEventListener('click', () => handleCloudAuthAction('unlock', 'CLOUD_SIGN_IN'));
  $('btn-unlock-cloud-sign-up')?.addEventListener('click', () => handleCloudAuthAction('unlock', 'CLOUD_SIGN_UP'));
  $('btn-create-cloud-sign-in')?.addEventListener('click', () => handleCloudAuthAction('create', 'CLOUD_SIGN_IN'));
  $('btn-create-cloud-sign-up')?.addEventListener('click', () => handleCloudAuthAction('create', 'CLOUD_SIGN_UP'));

  // Unlock form
  $('form-unlock')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearMsg('unlock-error');
    const masterPassword = $('unlock-password')?.value || '';
    const storageType    = $('unlock-storage')?.value || 'local';

    if (!masterPassword) { showError('unlock-error', 'Master password is required.'); return; }

    setLoading('btn-unlock', true);
    try {
      const userId = await getStoredUserId(storageType);
      const storageConfig = await getStorageConfig(storageType);
      const res = await sendMsg('UNLOCK_VAULT', {
        masterPassword,
        storageType,
        storageConfig,
        userId,
      });
      if (res?.success) {
        await storeUserId(storageType, res.userId);
        await markProviderVerified(storageType);
        await loadAndShowVault();
      } else {
        showError('unlock-error', res?.error || 'Wrong password or no vault found.');
      }
    } catch (err) {
      showError('unlock-error', err.message || 'Failed to unlock vault.');
    } finally {
      setLoading('btn-unlock', false);
    }
  });

  // Create vault form
  $('form-create')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearMsg('create-error');
    const masterPassword = $('create-password')?.value || '';
    const confirm        = $('create-password-confirm')?.value || '';
    const storageType    = $('create-storage')?.value || 'local';

    if (!masterPassword)           { showError('create-error', 'Master password is required.'); return; }
    if (masterPassword !== confirm) { showError('create-error', 'Passwords do not match.'); return; }
    if (scorePassword(masterPassword) < 2) {
      showError('create-error', 'Password is too weak. Use at least 12 characters with mixed case, digits and symbols.');
      return;
    }

    setLoading('btn-create', true);
    try {
      clearMsg('create-cloud-status');
      const storageConfig = await getStorageConfig(storageType);
      const userId = await getStoredUserId(storageType);
      const res = await sendMsg('CREATE_VAULT', {
        masterPassword,
        storageType,
        storageConfig,
        userId,
      });
      if (res?.success) {
        await storeUserId(storageType, res.userId);
        await markProviderVerified(storageType);
        await loadAndShowVault();
      } else {
        showError('create-error', res?.error || 'Failed to create vault.');
      }
    } catch (err) {
      showError('create-error', err.message || 'Failed to create vault.');
    } finally {
      setLoading('btn-create', false);
    }
  });

  updateCloudAuthPanel('unlock');
  updateCloudAuthPanel('create');
}

function updateCloudAuthPanel(mode) {
  const storageType = $(`${mode}-storage`)?.value || 'local';
  const panel = $(`${mode}-cloud-auth`);
  if (!panel) return;

  panel.classList.toggle('hidden', !CLOUD_AUTH_STORAGE_TYPES.has(storageType));
  clearMsg(`${mode}-cloud-status`);
}

async function handleCloudAuthAction(mode, actionType) {
  const storageType = $(`${mode}-storage`)?.value || 'local';
  const statusId = `${mode}-cloud-status`;
  clearMsg(statusId);

  if (!CLOUD_AUTH_STORAGE_TYPES.has(storageType)) {
    showError(statusId, 'This storage provider does not use email/password cloud sign-in.');
    return;
  }

  const email = $(`${mode}-cloud-email`)?.value?.trim() || '';
  const password = $(`${mode}-cloud-password`)?.value || '';
  if (!email || !password) {
    showError(statusId, 'Enter your cloud account email and password first.');
    return;
  }

  const buttonId = actionType === 'CLOUD_SIGN_IN'
    ? `btn-${mode}-cloud-sign-in`
    : `btn-${mode}-cloud-sign-up`;

  setLoading(buttonId, true);
  try {
    const storageConfig = await getStorageConfig(storageType);
    const res = await sendMsg(actionType, { storageType, storageConfig, email, password });
    if (!res?.success) {
      showError(statusId, res?.error || 'Cloud sign-in failed.');
      return;
    }

    if (res.userId) {
      await storeUserId(storageType, res.userId);
    }

    const authStatus = await sendMsg('GET_PROVIDER_AUTH_STATUS', { storageType, storageConfig });
    if (authStatus?.success && authStatus.userId) {
      await storeUserId(storageType, authStatus.userId);
    }

    const message = actionType === 'CLOUD_SIGN_UP'
      ? (res.requiresConfirmation
        ? 'Cloud account created. Confirm the email if your provider requires it, then sign in.'
        : 'Cloud account created and ready.')
      : `${STORAGE_PROVIDERS[storageType]?.label || 'Cloud'} account connected as ${authStatus?.userEmail || res.userEmail || email}.`;

    showSuccess(statusId, message);
  } catch (err) {
    showError(statusId, err.message || 'Cloud authentication failed.');
  } finally {
    setLoading(buttonId, false);
  }
}

// ─── Vault Screen ─────────────────────────────────────────────────────────────

function setupVaultScreen() {
  $('btn-lock')?.addEventListener('click', async () => {
    try {
      await sendMsg('LOCK_VAULT');
    } catch (err) {
      console.warn('[BYOV] LOCK_VAULT failed:', err.message);
    } finally {
      _currentItems = [];
      _editingItemId = null;
      showScreen('auth');
    }
  });

  $('btn-sync')?.addEventListener('click', async () => {
    const btn = $('btn-sync');
    if (btn) btn.classList.add('spinning');
    try {
      const res = await sendMsg('SYNC');
      updateSyncStatus(`Last sync: ${new Date().toLocaleTimeString()}`);
      if (res?.pulled) await refreshItemList();
    } catch (err) {
      updateSyncStatus(`Sync failed: ${err.message}`);
    } finally {
      if (btn) btn.classList.remove('spinning');
    }
  });

  $('btn-settings')?.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  $('btn-add')?.addEventListener('click', () => openItemEditor(null, getDefaultItemTypeForNewItem()));

  $('vault-search')?.addEventListener('input', (e) => {
    _searchQuery = e.target.value.toLowerCase();
    renderItems();
  });

  $('vault-filter')?.addEventListener('change', (e) => {
    _activeFilter = e.target.value;
    renderItems();
  });

  $('vault-sort')?.addEventListener('change', (e) => {
    _sortMode = e.target.value;
    renderItems();
  });
}

async function loadAndShowVault() {
  showScreen('vault');
  await refreshItemList();
  const status = await sendMsg('GET_STATUS');
  if (status?.lastSyncAt) {
    updateSyncStatus(`Last sync: ${new Date(status.lastSyncAt).toLocaleTimeString()}`);
  }
}

async function refreshItemList() {
  const res = await sendMsg('GET_ITEMS');
  const items = res?.items || [];
  _currentItems = await Promise.all(items.map((item) => hydrateItemPreview(item)));
  renderItems();
}

function renderItems() {
  const container = $('vault-items');
  const emptyState = $('empty-state');
  if (!container) return;

  // Filter
  const filtered = _currentItems.filter((item) => {
    if (_activeFilter !== 'all' && item.type !== _activeFilter) return false;
    if (_searchQuery) {
      const haystack = item._searchText || `${item.type} ${item.id}`.toLowerCase();
      return haystack.includes(_searchQuery);
    }
    return true;
  });
  const sorted = sortItems(filtered);

  // Remove old items (keep empty-state)
  container.querySelectorAll('.vault-item').forEach((el) => el.remove());

  if (sorted.length === 0) {
    if (emptyState) emptyState.classList.remove('hidden');
    return;
  }
  if (emptyState) emptyState.classList.add('hidden');

  for (const item of sorted) {
    const el = createItemElement(item);
    container.appendChild(el);
  }
}

function createItemElement(item) {
  const div = document.createElement('div');
  div.className = 'vault-item';
  div.setAttribute('role', 'listitem');
  div.dataset.id = item.id;
  div.tabIndex = 0;

  const icon = document.createElement('div');
  icon.className = 'item-icon';
  icon.textContent = itemTypeIcon(item.type);
  icon.title = friendlyItemType(item.type);
  icon.setAttribute('aria-label', friendlyItemType(item.type));

  const info = document.createElement('div');
  info.className = 'item-info';

  const title = document.createElement('div');
  title.className = 'item-title';
  title.textContent = item._previewTitle || `(${item.type})`;

  const subtitle = document.createElement('div');
  subtitle.className = 'item-subtitle';
  subtitle.textContent = item._previewSubtitle || '';

  info.appendChild(title);
  info.appendChild(subtitle);

  const meta = document.createElement('div');
  meta.className = 'item-hover-meta';
  meta.textContent = item._previewMeta || buildMetadataFallback(item);
  info.appendChild(meta);

  const copyBtn = document.createElement('button');
  copyBtn.className = 'item-copy-btn';
  copyBtn.textContent = '📋';
  copyBtn.title = 'Copy password';
  copyBtn.setAttribute('aria-label', 'Copy password to clipboard');
  copyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await copyItemPassword(item.id);
  });

  div.appendChild(icon);
  div.appendChild(info);
  if (item.type === 'login') div.appendChild(copyBtn);

  div.addEventListener('click', () => openItemEditor(item));
  div.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openItemEditor(item);
    }
  });

  return div;
}

async function hydrateItemPreview(item) {
  try {
    const res = await sendMsg('GET_ITEM_PLAINTEXT', { itemId: item.id });
    if (!res?.plaintext) return applyPreviewData(item, null);
    return applyPreviewData(item, res.plaintext);
  } catch {
    return applyPreviewData(item, null);
  }
}

async function copyItemPassword(itemId) {
  try {
    const res = await sendMsg('GET_ITEM_PLAINTEXT', { itemId });
    if (!res?.plaintext) return;
    const pwd = res.plaintext.password || '';
    await navigator.clipboard.writeText(pwd);
    updateSyncStatus('Password copied to clipboard ✓');
    const seconds = await getClipboardClearSeconds();
    if (seconds > 0) {
      // Schedule clear in background (popup may close before setTimeout fires)
      await sendMsg('SCHEDULE_CLIP_CLEAR', { seconds });
    }
  } catch {
    updateSyncStatus('Could not copy password.');
  }
}

function updateSyncStatus(msg) {
  const el = $('sync-status');
  if (el) el.textContent = msg;
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString();
}

// ─── Item Editor Screen ───────────────────────────────────────────────────────

function setupItemScreen() {
  $('btn-item-back')?.addEventListener('click', () => {
    showScreen('vault');
    _editingItemId = null;
  });

  $('item-type-select')?.addEventListener('change', (e) => {
    const t = e.target.value;
    switchItemTypeFields(t);
    $('item-screen-title').textContent = _editingItemId
      ? `Edit ${itemTypeLabel(t)}`
      : `Add ${itemTypeLabel(t)}`;
  });

  $('form-item')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearMsg('item-error');
    const itemType = $('item-type-select')?.value || 'login';
    const itemData = gatherItemData(itemType);

    setLoading('btn-save-item', true);
    try {
      let res;
      if (_editingItemId) {
        // Send only the canonical itemId — background looks up the encrypted
        // payload itself. Avoids races where popup state drifts from the
        // background after MV3 worker eviction.
        res = await sendMsg('UPDATE_ITEM', { itemId: _editingItemId, updatedData: itemData });
      } else {
        res = await sendMsg('ADD_ITEM', { itemData, itemType });
      }

      if (res?.success) {
        await refreshItemList();
        showScreen('vault');
        _editingItemId = null;
      } else {
        showError('item-error', res?.error || 'Failed to save item.');
      }
    } catch (err) {
      showError('item-error', err.message || 'Failed to save item.');
    } finally {
      setLoading('btn-save-item', false);
    }
  });

  $('btn-delete-item')?.addEventListener('click', async () => {
    if (!_editingItemId) return;
    if (!confirm('Delete this item? This cannot be undone.')) return;

    try {
      const res = await sendMsg('DELETE_ITEM', { itemId: _editingItemId });
      if (res?.success) {
        await refreshItemList();
        showScreen('vault');
        _editingItemId = null;
      }
    } catch (err) {
      showError('item-error', err.message);
    }
  });
}

function openItemEditor(item, preferredType = getDefaultItemTypeForNewItem()) {
  clearMsg('item-error');
  const typeSelect = $('item-type-select');

  if (item) {
    _editingItemId = item.id;
    $('item-screen-title').textContent = `Edit ${itemTypeLabel(item.type)}`;
    if (typeSelect) typeSelect.value = item.type;
    switchItemTypeFields(item.type);

    // Load and pre-fill plaintext
    sendMsg('GET_ITEM_PLAINTEXT', { itemId: item.id }).then((res) => {
      if (res?.plaintext) prefillItemForm(item.type, res.plaintext);
    });

    $('btn-delete-item').classList.remove('hidden');
  } else {
    _editingItemId = null;
    $('item-screen-title').textContent = `Add ${itemTypeLabel(preferredType)}`;
    if (typeSelect) typeSelect.value = preferredType;
    switchItemTypeFields(preferredType);
    clearItemForm();
    $('btn-delete-item').classList.add('hidden');
  }

  showScreen('item');
}

function switchItemTypeFields(type) {
  document.querySelectorAll('.item-fields').forEach((el) => el.classList.add('hidden'));
  $(`fields-${type}`)?.classList.remove('hidden');
  // Show/hide the generic notes field for all types
}

function clearItemForm() {
  const fields = [
    'item-title', 'item-username', 'item-password', 'item-url', 'item-totp',
    'note-title', 'note-body',
    'card-name', 'card-number', 'card-expiry', 'card-cvv', 'card-note',
    'id-first-name', 'id-last-name', 'id-email', 'id-phone', 'id-address',
    'item-notes',
  ];
  for (const id of fields) {
    const el = $(id);
    if (el) el.value = '';
  }
}

function prefillItemForm(type, plain) {
  if (type === 'login') {
    setValue('item-title',    plain.title    || '');
    setValue('item-username', plain.username || '');
    setValue('item-password', plain.password || '');
    setValue('item-url',      plain.url      || '');
    setValue('item-totp',     plain.totp     || '');
  } else if (type === 'note') {
    setValue('note-title', plain.note_title || '');
    setValue('note-body',  plain.note_body  || '');
  } else if (type === 'card') {
    setValue('card-name',   plain.card_name   || '');
    setValue('card-number', plain.card_number || '');
    setValue('card-expiry', plain.card_expiry || '');
    setValue('card-cvv',    plain.card_cvv    || '');
    setValue('card-note',   plain.card_note   || '');
  } else if (type === 'identity') {
    setValue('id-first-name', plain.first_name || '');
    setValue('id-last-name',  plain.last_name  || '');
    setValue('id-email',      plain.email      || '');
    setValue('id-phone',      plain.phone      || '');
    setValue('id-address',    plain.address    || '');
  }
  setValue('item-notes', plain.notes || '');
}

function gatherItemData(type) {
  const base = { notes: $('item-notes')?.value || '' };

  if (type === 'login') {
    return {
      ...base,
      title:    $('item-title')?.value    || '',
      username: $('item-username')?.value || '',
      password: $('item-password')?.value || '',
      url:      $('item-url')?.value      || '',
      totp:     $('item-totp')?.value     || '',
    };
  }
  if (type === 'note') {
    return {
      ...base,
      note_title: $('note-title')?.value || '',
      note_body:  $('note-body')?.value  || '',
    };
  }
  if (type === 'card') {
    return {
      ...base,
      card_name:   $('card-name')?.value   || '',
      card_number: $('card-number')?.value || '',
      card_expiry: $('card-expiry')?.value || '',
      card_cvv:    $('card-cvv')?.value    || '',
      card_note:   $('card-note')?.value   || '',
    };
  }
  if (type === 'identity') {
    return {
      ...base,
      first_name: $('id-first-name')?.value || '',
      last_name:  $('id-last-name')?.value  || '',
      email:      $('id-email')?.value      || '',
      phone:      $('id-phone')?.value      || '',
      address:    $('id-address')?.value    || '',
    };
  }
  return base;
}

function setValue(id, val) {
  const el = $(id);
  if (el) el.value = val;
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ─── Password Generator ───────────────────────────────────────────────────────

function setupPasswordGenerator() {
  $('btn-gen-password')?.addEventListener('click', () => {
    openPasswordGenerator();
  });

  $('gen-length')?.addEventListener('input', () => {
    const len = parseInt($('gen-length').value, 10);
    $('gen-length-label').textContent = len;
    refreshGeneratedPassword();
  });

  ['gen-upper', 'gen-lower', 'gen-digits', 'gen-symbols'].forEach((id) => {
    $(id)?.addEventListener('change', refreshGeneratedPassword);
  });

  $('btn-regen')?.addEventListener('click', refreshGeneratedPassword);

  $('btn-copy-gen')?.addEventListener('click', async () => {
    const pwd = $('gen-password-output')?.value || '';
    await navigator.clipboard.writeText(pwd);
    $('btn-copy-gen').textContent = '✓';
    setTimeout(() => { $('btn-copy-gen').textContent = '📋'; }, 1500);
  });

  $('btn-use-gen')?.addEventListener('click', () => {
    const pwd = $('gen-password-output')?.value || '';
    setValue('item-password', pwd);
    closeModal('modal-gen');
  });

  $('btn-close-gen')?.addEventListener('click', () => closeModal('modal-gen'));
}

function openPasswordGenerator() {
  $('modal-gen')?.classList.remove('hidden');
  refreshGeneratedPassword();
}

function refreshGeneratedPassword() {
  const length  = parseInt($('gen-length')?.value || '20', 10);
  const upper   = $('gen-upper')?.checked ?? true;
  const lower   = $('gen-lower')?.checked ?? true;
  const digits  = $('gen-digits')?.checked ?? true;
  const symbols = $('gen-symbols')?.checked ?? true;
  const pwd = generatePassword(length, { upper, lower, digits, symbols });
  setValue('gen-password-output', pwd);
}

function closeModal(id) {
  $(id)?.classList.add('hidden');
}

// ─── Import / Export ──────────────────────────────────────────────────────────

function setupImportExport() {
  // The Import/Export modal is opened from the options page.
  // But we also expose it via popup for quick access.
  // The settings button in popup opens the options page.
  // We keep the modal here for direct use.

  $('btn-export')?.addEventListener('click', async () => {
    try {
      const res = await sendMsg('EXPORT_VAULT');
      if (res?.json) {
        const date = new Date().toISOString().slice(0, 10);
        downloadFile(res.json, `vault-backup-${date}.byov`);
        showSuccess('import-status', 'Vault exported successfully.');
      } else {
        showError('import-status', res?.error || 'Export failed.');
      }
    } catch (err) {
      showError('import-status', err.message);
    }
  });

  $('btn-import')?.addEventListener('click', async () => {
    const file     = $('import-file')?.files?.[0];
    const password = $('import-password')?.value || '';

    if (!file)     { showError('import-status', 'Please select a .byov file.'); return; }
    if (!password) { showError('import-status', 'Master password is required.'); return; }

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const jsonString = e.target.result;
        const storageType = $('unlock-storage')?.value || 'local';
        const storageConfig = await getStorageConfig(storageType);
        const res = await sendMsg('IMPORT_VAULT', {
          jsonString,
          masterPassword: password,
          storageType,
          storageConfig,
          userId: await getStoredUserId(storageType),
        });
        if (res?.success) {
          await storeUserId(storageType, res.userId);
          await markProviderVerified(storageType);
          showSuccess('import-status', `Imported ${res.itemCount} items successfully.`);
          closeModal('modal-import-export');
          await loadAndShowVault();
        } else {
          showError('import-status', res?.error || 'Import failed.');
        }
      } catch (err) {
        showError('import-status', err.message);
      }
    };
    reader.readAsText(file);
  });

  $('btn-close-ie')?.addEventListener('click', () => closeModal('modal-import-export'));
}

// ─── Storage Config ───────────────────────────────────────────────────────────

async function getStorageConfig(storageType) {
  const settings = await getStorageSettings();
  return settings[storageType] || {};
}

async function getClipboardClearSeconds() {
  const res = await chrome.storage.local.get('byov_general_settings');
  const settings = res.byov_general_settings || {};
  return Number.isFinite(settings.clipboardClear) ? settings.clipboardClear : 30;
}

async function getStorageSettings() {
  const res = await chrome.storage.local.get(STORAGE_SETTINGS_KEY);
  return res[STORAGE_SETTINGS_KEY] || {};
}

async function getProviderHealth() {
  const res = await chrome.storage.local.get(PROVIDER_HEALTH_KEY);
  return res[PROVIDER_HEALTH_KEY] || { local: { working: true } };
}

async function markProviderVerified(storageType) {
  const health = await getProviderHealth();
  health[storageType] = {
    ...(health[storageType] || {}),
    working: true,
    lastSuccessAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [PROVIDER_HEALTH_KEY]: health });
}

async function populateStorageOptions() {
  const settings = await getStorageSettings();
  const health = await getProviderHealth();
  const providers = getAvailableProviders(settings, health);

  populateStorageSelect($('unlock-storage'), providers, settings.storageType || 'local');
  populateStorageSelect($('create-storage'), providers, 'local');
}

function getAvailableProviders(settings, health) {
  const providers = [{ value: 'local', label: STORAGE_PROVIDERS.local.label }];

  for (const [type, provider] of Object.entries(STORAGE_PROVIDERS)) {
    if (type === 'local') continue;
    const configured = provider.isReady(settings[type] || {});
    const tested = health[type]?.working === true;
    if (configured && (tested || type === settings.storageType)) {
      providers.push({ value: type, label: provider.label });
    }
  }

  return providers;
}

function populateStorageSelect(select, providers, preferredValue) {
  if (!select) return;
  select.innerHTML = '';
  for (const provider of providers) {
    const option = document.createElement('option');
    option.value = provider.value;
    option.textContent = provider.label;
    select.appendChild(option);
  }
  select.value = providers.some((provider) => provider.value === preferredValue)
    ? preferredValue
    : 'local';
}

function getDefaultItemTypeForNewItem() {
  return _activeFilter !== 'all' ? _activeFilter : 'login';
}

function sortItems(items) {
  const sorted = [...items];
  sorted.sort((a, b) => {
    switch (_sortMode) {
      case 'created_desc':
        return getCreatedTime(b) - getCreatedTime(a);
      case 'title_asc':
        return compareText(a._previewTitle, b._previewTitle);
      case 'title_desc':
        return compareText(b._previewTitle, a._previewTitle);
      case 'type_asc':
        return compareText(friendlyItemType(a.type), friendlyItemType(b.type))
          || compareText(a._previewTitle, b._previewTitle);
      case 'updated_desc':
      default:
        return getUpdatedTime(b) - getUpdatedTime(a);
    }
  });
  return sorted;
}

function compareText(a = '', b = '') {
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
}

function getUpdatedTime(item) {
  return new Date(item.updated_at || 0).getTime();
}

function getCreatedTime(item) {
  return new Date(item.created_at || item.updated_at || 0).getTime();
}

function applyPreviewData(item, plain) {
  const preview = buildItemPreview(item, plain);
  return {
    ...item,
    _previewTitle: preview.title,
    _previewSubtitle: preview.subtitle,
    _previewMeta: preview.meta,
    _searchText: preview.searchText,
  };
}

function buildItemPreview(item, plain) {
  const updated = item.updated_at ? new Date(item.updated_at).toLocaleString() : 'Unknown';
  const created = item.created_at ? new Date(item.created_at).toLocaleString() : 'Not tracked yet';
  const metaParts = [
    `Last modified: ${updated}`,
    `Created: ${created}`,
    `Version: ${item.item_version || 1}`,
  ];

  if (item.type === 'login') {
    const host = safeHostname(plain?.url);
    const title = plain?.title || host || 'Untitled Login';
    const subtitle = plain?.username || host || 'No username saved';
    if (host) metaParts.push(`Site: ${host}`);
    if (plain?.username) metaParts.push(`Username: ${plain.username}`);
    return {
      title,
      subtitle,
      meta: metaParts.join(' • '),
      searchText: `${title} ${subtitle} ${host || ''}`.toLowerCase(),
    };
  }

  if (item.type === 'note') {
    const title = plain?.note_title || 'Untitled Note';
    const subtitle = truncateText(plain?.note_body || plain?.notes || 'Secure note', 48);
    return {
      title,
      subtitle,
      meta: metaParts.join(' • '),
      searchText: `${title} ${plain?.note_body || ''} ${plain?.notes || ''}`.toLowerCase(),
    };
  }

  if (item.type === 'card') {
    const digits = String(plain?.card_number || '').replace(/\D/g, '');
    const ending = digits ? digits.slice(-5) : 'unknown';
    const title = `Card ending in ${ending}`;
    const subtitle = plain?.card_name || plain?.card_expiry || 'Payment card';
    if (plain?.card_expiry) metaParts.push(`Expiry: ${plain.card_expiry}`);
    return {
      title,
      subtitle,
      meta: metaParts.join(' • '),
      searchText: `${title} ${subtitle}`.toLowerCase(),
    };
  }

  const fullName = [plain?.first_name, plain?.last_name].filter(Boolean).join(' ').trim();
  const title = fullName || plain?.email || 'Identity';
  const subtitle = plain?.email || plain?.phone || 'Identity record';
  if (plain?.phone) metaParts.push(`Phone: ${plain.phone}`);
  return {
    title,
    subtitle,
    meta: metaParts.join(' • '),
    searchText: `${title} ${subtitle}`.toLowerCase(),
  };
}

function truncateText(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function safeHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

function friendlyItemType(type) {
  return itemTypeLabel(type);
}

function buildMetadataFallback(item) {
  const updated = item.updated_at ? new Date(item.updated_at).toLocaleString() : 'Unknown';
  return `Last modified: ${updated}`;
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

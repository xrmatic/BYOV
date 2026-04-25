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
let _editingItemId   = null; // null = new item, string = editing existing

// ─── Helpers ──────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function showScreen(name) {
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
    btn.dataset.origText = btn.textContent;
    btn.innerHTML = '<span class="spinner"></span> Working…';
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.origText || btn.textContent;
    btn.disabled = false;
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

// ─── Initialisation ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
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

  // Unlock form
  $('form-unlock')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearMsg('unlock-error');
    const masterPassword = $('unlock-password')?.value || '';
    const storageType    = $('unlock-storage')?.value || 'local';

    if (!masterPassword) { showError('unlock-error', 'Master password is required.'); return; }

    setLoading('btn-unlock', true);
    try {
      const userId = await getStoredUserId();
      const res = await sendMsg('UNLOCK_VAULT', {
        masterPassword,
        storageType,
        storageConfig: getStorageConfig(storageType),
        userId,
      });
      if (res?.success) {
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
      const res = await sendMsg('CREATE_VAULT', {
        masterPassword,
        storageType,
        storageConfig: getStorageConfig(storageType),
      });
      if (res?.success) {
        await storeUserId(res.userId);
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
}

// ─── Vault Screen ─────────────────────────────────────────────────────────────

function setupVaultScreen() {
  $('btn-lock')?.addEventListener('click', async () => {
    await sendMsg('LOCK_VAULT');
    _currentItems = [];
    showScreen('auth');
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

  $('btn-add')?.addEventListener('click', () => openItemEditor(null));

  $('vault-search')?.addEventListener('input', (e) => {
    _searchQuery = e.target.value.toLowerCase();
    renderItems();
  });

  document.querySelectorAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      _activeFilter = btn.dataset.type;
      renderItems();
    });
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
  _currentItems = res?.items || [];
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
      const haystack = `${item.type} ${item.id}`.toLowerCase();
      return haystack.includes(_searchQuery);
    }
    return true;
  });

  // Remove old items (keep empty-state)
  container.querySelectorAll('.vault-item').forEach((el) => el.remove());

  if (filtered.length === 0) {
    if (emptyState) emptyState.classList.remove('hidden');
    return;
  }
  if (emptyState) emptyState.classList.add('hidden');

  for (const item of filtered) {
    const el = createItemElement(item);
    container.appendChild(el);
  }
}

function createItemElement(item) {
  const div = document.createElement('div');
  div.className = 'vault-item';
  div.setAttribute('role', 'listitem');
  div.dataset.id = item.id;

  const icon = document.createElement('div');
  icon.className = 'item-icon';
  icon.textContent = itemTypeIcon(item.type);

  const info = document.createElement('div');
  info.className = 'item-info';

  const title = document.createElement('div');
  title.className = 'item-title';
  title.textContent = item._plainTitle || `(${item.type})`;

  const subtitle = document.createElement('div');
  subtitle.className = 'item-subtitle';
  subtitle.textContent = item._plainSubtitle || formatDate(item.updated_at);

  info.appendChild(title);
  info.appendChild(subtitle);

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

  // Decrypt title/subtitle lazily for display
  loadItemPreview(item, title, subtitle);

  return div;
}

async function loadItemPreview(item, titleEl, subtitleEl) {
  try {
    const res = await sendMsg('GET_ITEM_PLAINTEXT', { itemId: item.id });
    if (!res?.plaintext) return;
    const plain = res.plaintext;
    titleEl.textContent = plain.title || plain.note_title || `(${item.type})`;
    subtitleEl.textContent = plain.username || plain.email || formatDate(item.updated_at);
  } catch {
    // Non-fatal; leave placeholder text
  }
}

async function copyItemPassword(itemId) {
  try {
    const res = await sendMsg('GET_ITEM_PLAINTEXT', { itemId });
    if (!res?.plaintext) return;
    const pwd = res.plaintext.password || '';
    await navigator.clipboard.writeText(pwd);
    updateSyncStatus('Password copied to clipboard ✓');
    // Clear clipboard after 30 seconds
    setTimeout(() => navigator.clipboard.writeText(''), 30000);
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
    switchItemTypeFields(e.target.value);
    $('item-screen-title').textContent = _editingItemId
      ? `Edit ${capitalize(e.target.value)}`
      : `Add ${capitalize(e.target.value)}`;
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
        // Find existing encrypted item
        const existing = _currentItems.find((i) => i.id === _editingItemId);
        if (!existing) throw new Error('Item not found');
        res = await sendMsg('UPDATE_ITEM', { existingItem: existing, updatedData: itemData });
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

function openItemEditor(item) {
  clearMsg('item-error');
  const typeSelect = $('item-type-select');

  if (item) {
    _editingItemId = item.id;
    $('item-screen-title').textContent = `Edit ${capitalize(item.type)}`;
    if (typeSelect) typeSelect.value = item.type;
    switchItemTypeFields(item.type);

    // Load and pre-fill plaintext
    sendMsg('GET_ITEM_PLAINTEXT', { itemId: item.id }).then((res) => {
      if (res?.plaintext) prefillItemForm(item.type, res.plaintext);
    });

    $('btn-delete-item').classList.remove('hidden');
  } else {
    _editingItemId = null;
    $('item-screen-title').textContent = 'Add Login';
    if (typeSelect) typeSelect.value = 'login';
    switchItemTypeFields('login');
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
        const res = await sendMsg('IMPORT_VAULT', {
          jsonString,
          masterPassword: password,
          storageType,
          storageConfig: getStorageConfig(storageType),
        });
        if (res?.success) {
          await storeUserId(res.userId);
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

function getStorageConfig(storageType) {
  // Pull storage provider configs from extension storage settings
  // In a full implementation these would be set in the options page
  const configs = {};
  return configs[storageType] || {};
}

async function getStoredUserId() {
  const res = await chrome.storage.local.get('byov_user_id');
  return res.byov_user_id || null;
}

async function storeUserId(userId) {
  await chrome.storage.local.set({ byov_user_id: userId });
}

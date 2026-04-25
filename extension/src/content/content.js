/**
 * BYOV Content Script – Autofill
 *
 * Detects login forms on the page and injects BYOV autofill suggestions.
 * All credential lookups go through the background service worker; this
 * script never handles encryption keys or plaintext passwords directly
 * beyond the moment of DOM injection.
 */

(function byovContentScript() {
  // Avoid double-injection
  if (window.__byovInjected) return;
  window.__byovInjected = true;

  const hostname = window.location.hostname;

  // ─── Message listener (from background service worker) ─────────────────────
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'TRIGGER_AUTOFILL') {
      triggerAutofill();
    }
  });

  // ─── Autofill trigger ────────────────────────────────────────────────────────

  async function triggerAutofill() {
    const passwordFields = document.querySelectorAll('input[type="password"]');
    if (passwordFields.length === 0) return;

    // Ask background for matching credentials
    const response = await chrome.runtime.sendMessage({
      type: 'AUTOFILL_QUERY',
      payload: { hostname },
    });

    if (!response?.items?.length) {
      showNotification('No saved credentials for this site.');
      return;
    }

    if (response.items.length === 1) {
      await fillCredentials(response.items[0], passwordFields[0]);
    } else {
      showPicker(response.items, passwordFields[0]);
    }
  }

  // ─── Fill credentials into the form ─────────────────────────────────────────

  async function fillCredentials(itemMeta, passwordField) {
    // Request full plaintext from background (only the specific item the user chose)
    const response = await chrome.runtime.sendMessage({
      type: 'GET_ITEM_PLAINTEXT',
      payload: { itemId: itemMeta.id },
    });

    if (!response?.plaintext) return;
    const { username, password } = response.plaintext;

    // Find username field (look before the password field in the DOM)
    const usernameField = findUsernameField(passwordField);
    if (usernameField && username) {
      fillField(usernameField, username);
    }
    if (password) {
      fillField(passwordField, password);
    }

    // Announce fill for accessibility
    announceAutofill(itemMeta.title || hostname);
  }

  // ─── Picker UI (multiple credentials) ────────────────────────────────────────

  function showPicker(items, passwordField) {
    removePicker(); // remove any existing picker

    const picker = document.createElement('div');
    picker.id = 'byov-picker';
    picker.setAttribute('role', 'listbox');
    picker.setAttribute('aria-label', 'BYOV: Choose credentials');
    applyPickerStyles(picker);

    const header = document.createElement('div');
    header.className = 'byov-picker-header';
    header.textContent = '🔐 BYOV – Choose credentials';
    picker.appendChild(header);

    for (const item of items) {
      const option = document.createElement('div');
      option.className = 'byov-picker-option';
      option.setAttribute('role', 'option');
      option.setAttribute('tabindex', '0');
      option.innerHTML = `<strong>${escapeHtml(item.title || hostname)}</strong>
        <span class="byov-username">${escapeHtml(item.username || '')}</span>`;

      option.addEventListener('click', async () => {
        removePicker();
        await fillCredentials(item, passwordField);
      });
      option.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          removePicker();
          await fillCredentials(item, passwordField);
        }
      });
      picker.appendChild(option);
    }

    const closeBtn = document.createElement('button');
    closeBtn.className = 'byov-picker-close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Close BYOV picker');
    closeBtn.addEventListener('click', removePicker);
    picker.appendChild(closeBtn);

    // Position near the password field
    const rect = passwordField.getBoundingClientRect();
    picker.style.top  = `${window.scrollY + rect.bottom + 4}px`;
    picker.style.left = `${window.scrollX + rect.left}px`;

    document.body.appendChild(picker);

    // Close if user clicks away
    document.addEventListener('click', outsideClickHandler, { once: true, capture: true });
  }

  function outsideClickHandler(e) {
    const picker = document.getElementById('byov-picker');
    if (picker && !picker.contains(e.target)) removePicker();
  }

  function removePicker() {
    const el = document.getElementById('byov-picker');
    if (el) el.remove();
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  function findUsernameField(passwordField) {
    // Walk backwards through form fields to find the nearest text/email input
    const form = passwordField.closest('form');
    const container = form || document;
    const inputs = Array.from(
      container.querySelectorAll('input[type="text"], input[type="email"], input:not([type])'),
    );
    // Return the last input that appears before the password field in the DOM
    const pwIndex = getNodeIndex(passwordField);
    const candidates = inputs.filter((el) => getNodeIndex(el) < pwIndex);
    return candidates[candidates.length - 1] || null;
  }

  function getNodeIndex(el) {
    const all = Array.from(document.querySelectorAll('*'));
    return all.indexOf(el);
  }

  /** Fills a field value and dispatches input events to trigger SPA reactivity. */
  function fillField(field, value) {
    field.focus();
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    // Simulate keyboard input for frameworks that listen to keydown
    field.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }

  function showNotification(message) {
    const el = document.createElement('div');
    el.id = 'byov-notification';
    el.setAttribute('role', 'alert');
    el.setAttribute('aria-live', 'polite');
    el.textContent = `🔐 BYOV: ${message}`;
    applyNotificationStyles(el);
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }

  function announceAutofill(title) {
    showNotification(`Filled credentials for "${title}"`);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── Inline CSS (injected into page, scoped with byov- prefix) ──────────────

  function applyPickerStyles(el) {
    Object.assign(el.style, {
      position: 'absolute',
      zIndex: '2147483647',
      background: '#1e1e2e',
      color: '#cdd6f4',
      border: '1px solid #6c7086',
      borderRadius: '8px',
      padding: '8px',
      minWidth: '260px',
      maxWidth: '360px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '13px',
    });

    const style = document.createElement('style');
    style.textContent = `
      #byov-picker .byov-picker-header { font-weight: bold; padding: 4px 8px; border-bottom: 1px solid #45475a; margin-bottom: 4px; }
      #byov-picker .byov-picker-option { padding: 8px; border-radius: 4px; cursor: pointer; display: flex; flex-direction: column; gap: 2px; }
      #byov-picker .byov-picker-option:hover, #byov-picker .byov-picker-option:focus { background: #313244; outline: 2px solid #89b4fa; }
      #byov-picker .byov-username { color: #a6adc8; font-size: 11px; }
      #byov-picker .byov-picker-close { position: absolute; top: 6px; right: 8px; background: none; border: none; color: #a6adc8; font-size: 18px; cursor: pointer; line-height: 1; padding: 0; }
    `;
    document.head.appendChild(style);
  }

  function applyNotificationStyles(el) {
    Object.assign(el.style, {
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      zIndex: '2147483647',
      background: '#1e1e2e',
      color: '#cdd6f4',
      border: '1px solid #89b4fa',
      borderRadius: '8px',
      padding: '10px 16px',
      fontSize: '13px',
      fontFamily: 'system-ui, sans-serif',
      boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
    });
  }

  // ─── Auto-detect password fields and show BYOV icon ─────────────────────────

  function injectAutofillIcons() {
    const passwordFields = document.querySelectorAll('input[type="password"]:not([data-byov])');
    for (const field of passwordFields) {
      field.setAttribute('data-byov', 'true');
      const wrapper = wrapWithPositionRelative(field);
      if (!wrapper) continue;

      const icon = document.createElement('button');
      icon.type = 'button';
      icon.setAttribute('aria-label', 'BYOV: Autofill password');
      icon.title = 'BYOV Autofill';
      icon.innerHTML = '🔐';
      Object.assign(icon.style, {
        position: 'absolute',
        right: '6px',
        top: '50%',
        transform: 'translateY(-50%)',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        fontSize: '16px',
        zIndex: '9999',
        padding: '0',
        lineHeight: '1',
      });
      icon.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        triggerAutofill();
      });

      wrapper.appendChild(icon);
    }
  }

  function wrapWithPositionRelative(field) {
    // Only wrap if we can safely do so (avoid breaking complex form layouts)
    const parent = field.parentElement;
    if (!parent) return null;
    const cs = window.getComputedStyle(parent);
    if (cs.position === 'static') {
      parent.style.position = 'relative';
    }
    return parent;
  }

  // Run icon injection once DOM is ready and observe for dynamic forms
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectAutofillIcons);
  } else {
    injectAutofillIcons();
  }

  // Re-check for new password fields added dynamically
  const observer = new MutationObserver(() => injectAutofillIcons());
  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });
})();

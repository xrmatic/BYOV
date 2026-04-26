# BYOV — Bring Your Own Vault

> A zero-knowledge password manager browser extension for Microsoft Edge and Chrome, with flexible encrypted vault storage. Your vault, your keys.

---

## What changed in this version

- **The custom Express/Postgres sync API is gone.** BYOV now talks directly to Supabase via PostgREST, with **Row-Level Security** as the access-control layer.
- **Autofill was hardened.** Content scripts are now registered dynamically, autofill respects the real user setting, hostname matching is exact, and plaintext autofill requests are tied to trusted sender context plus a short-lived authorization token.
- **Clipboard auto-clear** now runs through `chrome.alarms` in the background, so it still fires after the popup closes.
- **Settings are more vault-aware.** The Settings page now shows a locked state when the vault is unavailable, includes a Local Device vault summary + local vault creation flow, and refreshes after successful import with a short countdown.
- **The vault list UI was upgraded.** The popup now uses filter and sort dropdowns, better item labels, richer hover metadata, and opens the matching form type when you add an item from a filtered view.

---

## Choose your storage backend

You don't need both. Pick whichever matches your appetite for setup.

| If you want… | Use | Cost | Setup |
|---|---|---|---|
| **Zero infrastructure**, sync via a cloud account you already have | Local + **Google Drive** | Free | [GOOGLE_DRIVE_SETUP.md](GOOGLE_DRIVE_SETUP.md) — recommended |
| Database-style sync with email/password accounts | **Supabase** | Free tier (500 MB DB, 50k MAU) | [SUPABASE_SETUP.md](SUPABASE_SETUP.md) |
| Offline only | **Local Device** | Free | Just install the extension |
| Existing Microsoft 365 account | **OneDrive** | Free | Register an Azure app (similar to GDrive) |
| Existing Dropbox account | **Dropbox** | Free | Register a Dropbox app |
| Realtime sync with Google sign-in | **Firebase** | Free Spark tier | Configure a Firebase project |

The vault format is identical across providers — you can switch between them by exporting a `.byov` file and re-importing.

In the popup, **Local Device** is always available and is the default for new vault creation. Other providers are only shown once they are configured, and BYOV prefers providers that have already been successfully used in the current profile.

---

## Security design

| Layer | Algorithm | Library |
|-------|-----------|---------|
| Master password → KEK | Argon2id (64 MiB, t=3, p=4, 32-byte output) | `argon2-browser` |
| Vault key wrap | AES-256-GCM (96-bit nonce) | WebCrypto |
| Item encryption | XChaCha20-Poly1305 (192-bit nonce) | `libsodium-wrappers` |
| Cloud auth | Supabase JWT / OAuth tokens | provider-specific |
| All nonces | `crypto.getRandomValues()` / `randombytes_buf()` | per-operation |

**Two-level key scheme:**

```
masterPassword + salt ──[Argon2id]──► KEK
                                       │
                          ┌────────────┴────────────┐
                          ▼                         │
             random vaultKey ──[AES-256-GCM]──► wrappedVaultKey   (in vault header)
                          │
                          ▼
              item JSON ──[XChaCha20-Poly1305]──► encrypted_payload   (per item)
```

Password change re-wraps the vault key only — items are untouched. The vault key never leaves the device unencrypted; the cloud only sees ciphertext.

### Extension hardening

- Autofill can be fully disabled, and when disabled the content script is unregistered rather than merely hidden.
- Autofill now requires a trusted extension-mediated path instead of accepting unscoped plaintext fetches from any content-script message.
- Exact host matching is used for autofill lookup; parent-domain matching is no longer allowed.
- Password change requires the **current** master password, not just an already-unlocked session.
- Session rehydration after MV3 worker eviction is controlled from Settings via **Background Session**.

---

## Install (Chrome / Edge)

```bash
cd extension
npm install
npm run build
```

Then in `chrome://extensions` (or `edge://extensions`):
1. Enable **Developer mode**
2. Click **Load unpacked**
3. Select `extension/dist/`

### First run

1. Open the BYOV popup.
2. Create a vault with **Local Device** or a configured provider.
3. Open **Settings** to configure storage, review the current local vault, or import/export a `.byov` file.
4. If the vault is locked, Settings will show a locked-state screen until you unlock BYOV from the popup.

---

## Vault file format (`.byov`)

```jsonc
{
  "format":              "BYOV/1",
  "salt":                "<base64>",
  "wrapped_vault_key":   "<base64>",
  "wrapped_vault_nonce": "<base64>",
  "device_id":           "<uuid>",
  "sync_token":          "version_0",
  "items": [
    {
      "id":                "<uuid>",
      "type":              "login | note | card | identity",
      "encrypted_payload": "<base64>",
      "nonce":             "<base64>",
      "item_version":      1,
      "created_at":        "<iso>",
      "updated_at":        "<iso>",
      "device_id":         "<uuid>"
    }
  ]
}
```

---

## Project layout

```
BYOV/
├── extension/
│   ├── manifest.json
│   ├── supabase-schema.sql        # paste into Supabase SQL Editor
│   ├── src/
│   │   ├── crypto/                # crypto.js (Argon2id + XChaCha20), vault.js
│   │   ├── storage/               # 6 providers, all extending StorageProvider
│   │   ├── sync/                  # SyncManager
│   │   ├── background/            # MV3 service worker
│   │   ├── content/               # autofill content script
│   │   ├── popup/                 # popup UI
│   │   └── options/               # settings page
│   └── tests/                     # Jest unit tests
├── GOOGLE_DRIVE_SETUP.md          # recommended path — zero infrastructure
├── SUPABASE_SETUP.md              # alternate — DB-style sync
└── README.md
```

---

## Cryptography rules (for contributors)

- **Never** use MD5, SHA-1, or plain SHA-256 for password hashing.
- **Never** store the master password — derive the KEK and discard.
- **Always** use random nonces — `crypto.getRandomValues()` / `sodium.randombytes_buf()`.
- **Zero** key material with `zeroMemory()` when no longer needed.
- **Don't** roll your own crypto — use libsodium and WebCrypto.

## Current UX notes

- The vault list supports **filter + sort** dropdowns and shows better item previews:
  - Logins: title/site name
  - Notes: note title
  - Cards: last five digits
  - Identity: first and last name
- Hovering an item reveals extra metadata such as created date, last modified, and item version.
- Adding a new item from a filtered view opens the matching item form by default.

## License

MIT

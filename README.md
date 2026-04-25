# BYOV – Bring Your Own Vault

> A zero-knowledge password manager browser extension for Microsoft Edge and Chrome, with flexible encrypted vault storage.

---

## Overview

BYOV lets you store passwords and sensitive data in a fully-encrypted vault whose **keys never leave your devices**. The server (or cloud provider) only ever sees encrypted blobs; it has no ability to decrypt your data.

### Unique Feature
Import/export is first-class: the encrypted vault is a portable `.byov` file that can be attached to any compatible device. Detach it to revoke access; re-attach to restore.

---

## Security Design

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Master password → KEK | **Argon2id** (64 MiB, 3 iter, 4 threads) | Memory-hard KDF, OWASP-recommended |
| Vault key wrapping | **AES-256-GCM** (WebCrypto) | Protects vault key with KEK |
| Item encryption | **XChaCha20-Poly1305** (libsodium) | Authenticated encryption per item |
| Auth | **Supabase / Firebase** JWT | Account access only; cannot decrypt vault |
| Nonces | Cryptographically random | Generated fresh per operation |

**Two-level key scheme:**
```
masterPassword + salt ──[Argon2id]──► KEK
                                        │
                                        ▼
               random vaultKey ──[AES-256-GCM]──► wrappedVaultKey  (stored in vault header)
                    │
                    ▼
         item data ──[XChaCha20-Poly1305]──► encrypted_payload  (stored per item)
```

Benefits: password change only re-wraps the vault key (items unchanged); multi-device sync is trivial.

---

## Project Structure

```
BYOV/
├── extension/          # Browser extension (MV3)
│   ├── manifest.json
│   ├── src/
│   │   ├── crypto/     # crypto.js (Argon2id + XChaCha20), vault.js
│   │   ├── storage/    # StorageProvider + all 6 providers
│   │   ├── sync/       # SyncManager
│   │   ├── background/ # service-worker.js
│   │   ├── content/    # autofill content script
│   │   ├── popup/      # popup UI (HTML/CSS/JS)
│   │   └── options/    # settings page (HTML/CSS/JS)
│   └── tests/          # Jest unit tests
├── api/                # Sync API backend (Node.js + Express)
│   ├── server.js
│   ├── routes/         # auth, vault, sync, items
│   ├── middleware/      # JWT auth
│   ├── db/             # schema.sql + pg client
│   └── tests/          # supertest API tests
└── package.json        # workspace root
```

---

## Storage Providers

| Provider | Type Key | Notes |
|----------|----------|-------|
| Local Device | `local` | browser `chrome.storage.local`; offline-first |
| Firebase Firestore | `firebase` | per-item sync via Firestore |
| Supabase Sync API | `supabase` | REST API backed by Postgres |
| Microsoft OneDrive | `onedrive` | single `vault.byov` file via Graph API |
| Google Drive | `googledrive` | hidden `vault.byov` in `appDataFolder` |
| Dropbox | `dropbox` | `vault.byov` in `/Apps/BYOV/` |

New providers can be added by extending `StorageProvider` and registering in `src/storage/index.js`.

---

## Vault File Format (`.byov`)

```json
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
      "type":              "login|note|card|identity",
      "encrypted_payload": "<base64>",
      "nonce":             "<base64>",
      "item_version":      1,
      "updated_at":        "<iso>",
      "device_id":         "<uuid>"
    }
  ]
}
```

---

## Sync API

```
GET  /health
POST /auth/signup
POST /auth/login
POST /auth/refresh

GET  /vault/header           → { header }
PUT  /vault/header           ← { salt, wrapped_vault_key, wrapped_vault_nonce, … }

GET  /sync?since=version_…   → { items, sync_token, count }
POST /items                  ← EncryptedItem
PUT  /items/:id              ← EncryptedItem
DELETE /items/:id            → 204
```

All item endpoints require a valid Supabase JWT (`Authorization: Bearer <token>`). Row-Level Security in Postgres ensures users can only access their own data.

---

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Build the extension

```bash
cd extension
npm install
npm run build          # production build → extension/dist/
npm run dev            # development watch mode
```

### 3. Load in Edge / Chrome

1. Open `edge://extensions` (or `chrome://extensions`)
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/dist/` folder

### 4. Run the Sync API

```bash
cd api
npm install
cp .env.example .env   # fill in your Supabase credentials
npm run migrate        # run DB schema against Postgres
npm start
```

### 5. Run tests

```bash
npm test               # runs both extension and API test suites
npm run test:extension # extension unit tests only
npm run test:api       # API integration tests only
```

---

## Development

### Adding a Storage Provider

1. Create `extension/src/storage/MyProvider.js` extending `StorageProvider`.
2. Implement: `connect`, `saveVaultHeader`, `loadVaultHeader`, `saveItem`, `deleteItem`, `getChanges`.
3. Add to the registry in `extension/src/storage/index.js`.
4. Add a config section in `extension/src/options/options.html`.

### Cryptography Notes

- **Never use MD5, SHA-1, or plain SHA-256** for password hashing.
- **Never store the master password** – derive the KEK and discard the password.
- **Always use random nonces** – `crypto.getRandomValues()` / `sodium.randombytes_buf()`.
- **Zero key material** after use with `zeroMemory()`.
- **Do not implement your own crypto** – use libsodium and WebCrypto.

---

## License

MIT


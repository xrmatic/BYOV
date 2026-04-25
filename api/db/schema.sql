-- BYOV Vault Schema
-- Zero-knowledge sync: server stores encrypted blobs only.
-- The server never sees plaintext vault data or master passwords.

-- ─── Extensions ─────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Vault Headers ──────────────────────────────────────────────────────────

-- Stores encrypted vault metadata (salt, wrapped vault key).
-- The server cannot decrypt this data.
CREATE TABLE IF NOT EXISTS vault_headers (
  user_id         UUID        PRIMARY KEY,
  format          TEXT        NOT NULL DEFAULT 'BYOV/1',
  salt            TEXT        NOT NULL,       -- Argon2id salt (base64)
  wrapped_vault_key  TEXT     NOT NULL,       -- AES-256-GCM(vaultKey, KEK) (base64)
  wrapped_vault_nonce TEXT    NOT NULL,       -- AES-256-GCM nonce (base64)
  device_id       UUID        NOT NULL,
  sync_token      TEXT        NOT NULL DEFAULT 'version_0',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Vault Items ─────────────────────────────────────────────────────────────

-- Each row is a single encrypted vault item.
-- encrypted_payload is XChaCha20-Poly1305(JSON item data, vault_key).
-- The server cannot decrypt this data.
CREATE TABLE IF NOT EXISTS vault_items (
  id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID        NOT NULL REFERENCES vault_headers(user_id) ON DELETE CASCADE,
  type                TEXT        NOT NULL CHECK (type IN ('login', 'note', 'card', 'identity')),
  encrypted_payload   TEXT        NOT NULL,   -- base64-encoded ciphertext
  nonce               TEXT        NOT NULL,   -- base64-encoded XChaCha20 nonce
  item_version        INTEGER     NOT NULL DEFAULT 1,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  device_id           UUID        NOT NULL,
  deleted             BOOLEAN     NOT NULL DEFAULT FALSE,
  -- Breach-resistant audit log (no plaintext content)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Item History ─────────────────────────────────────────────────────────────

-- Retains previous versions of vault items for recovery.
CREATE TABLE IF NOT EXISTS vault_item_history (
  history_id        UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  item_id           UUID        NOT NULL,
  user_id           UUID        NOT NULL,
  encrypted_payload TEXT        NOT NULL,
  nonce             TEXT        NOT NULL,
  item_version      INTEGER     NOT NULL,
  device_id         UUID        NOT NULL,
  archived_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Device Revocation ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS revoked_devices (
  device_id   UUID        PRIMARY KEY,
  user_id     UUID        NOT NULL,
  revoked_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason      TEXT
);

-- ─── Indices ─────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_vault_items_user_id    ON vault_items(user_id);
CREATE INDEX IF NOT EXISTS idx_vault_items_updated_at ON vault_items(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_vault_items_deleted    ON vault_items(user_id, deleted);

-- ─── Row-Level Security (Supabase) ───────────────────────────────────────────

ALTER TABLE vault_headers  ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_items    ENABLE ROW LEVEL SECURITY;

-- Users can only read/write their own data
CREATE POLICY "vault_headers_owner" ON vault_headers
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "vault_items_owner" ON vault_items
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ─── Breach-resistant audit log ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID,
  action      TEXT        NOT NULL,   -- 'sync', 'item_write', 'item_delete', 'vault_create'
  device_id   UUID,
  item_id     UUID,
  ip_hash     TEXT,                   -- SHA-256(IP) – no raw IPs stored
  user_agent  TEXT,
  timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user_id ON audit_log(user_id, timestamp);

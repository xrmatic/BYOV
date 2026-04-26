-- BYOV — Supabase schema
-- Paste this into the Supabase Dashboard → SQL Editor → New query → Run.
-- Zero-knowledge: the database stores only encrypted blobs.
-- All access control is enforced by Row-Level Security (RLS).

-- ─── Vault headers (one row per user) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vault_headers (
  user_id              UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  format               TEXT        NOT NULL DEFAULT 'BYOV/1',
  salt                 TEXT        NOT NULL,    -- Argon2id salt (base64)
  wrapped_vault_key    TEXT        NOT NULL,    -- AES-256-GCM(vaultKey, KEK)
  wrapped_vault_nonce  TEXT        NOT NULL,
  device_id            UUID        NOT NULL,
  sync_token           TEXT        NOT NULL DEFAULT 'version_0',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Vault items (one row per encrypted entry) ───────────────────────────────
CREATE TABLE IF NOT EXISTS vault_items (
  id                 UUID        PRIMARY KEY,
  user_id            UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type               TEXT        NOT NULL CHECK (type IN ('login','note','card','identity')),
  encrypted_payload  TEXT        NOT NULL,     -- XChaCha20-Poly1305 ciphertext (base64)
  nonce              TEXT        NOT NULL,
  item_version       INTEGER     NOT NULL DEFAULT 1,
  device_id          UUID        NOT NULL,
  deleted            BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vault_items_user_updated
  ON vault_items (user_id, updated_at);

-- ─── Row-Level Security ──────────────────────────────────────────────────────
ALTER TABLE vault_headers ENABLE ROW LEVEL SECURITY;
ALTER TABLE vault_items   ENABLE ROW LEVEL SECURITY;

-- Owners only — read, write, update, delete.
DROP POLICY IF EXISTS vault_headers_owner ON vault_headers;
CREATE POLICY vault_headers_owner ON vault_headers
  FOR ALL
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS vault_items_owner ON vault_items;
CREATE POLICY vault_items_owner ON vault_items
  FOR ALL
  USING      (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

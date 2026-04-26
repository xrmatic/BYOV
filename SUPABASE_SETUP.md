# BYOV — Supabase setup

Supabase gives you a real Postgres database with an HTTP API (PostgREST) and email/password auth. With this setup, the extension talks **directly** to Supabase — there is no separate server to host. Row-Level Security in Postgres is the only access control, which is exactly what RLS is designed for.

Cost: **Free** for typical personal use (Supabase free tier: 500 MB database, 50,000 monthly active users, 5 GB bandwidth).

---

## Step 1 — Install Node.js and build the extension

```bash
# Node from https://nodejs.org (LTS)
cd C:\Users\Bob\Projects\BYOV\extension
npm install
npm run build
```

Load `extension/dist/` in `chrome://extensions` (Developer mode → Load unpacked).

---

## Step 2 — Create a Supabase project

1. Go to <https://supabase.com> → sign up (GitHub login is fastest).
2. Dashboard → **New project**.
   - Name: `byov`
   - Database password: generate a strong one — store it in a *different* password manager or password file (you only need it for Postgres admin tasks; the extension never sees it).
   - Region: pick the one closest to you.
3. Wait ~2 minutes for the project to provision.

---

## Step 3 — Apply the schema

1. In your project dashboard: left sidebar → **SQL Editor → New query**.
2. Open `extension/supabase-schema.sql` from this repo, copy the full contents, paste into the editor.
3. Click **Run**. You should see "Success. No rows returned."
4. Sidebar → **Table Editor**. You should see `vault_headers` and `vault_items` with **RLS Enabled** badges (green shield icon).

---

## Step 4 — Disable email confirmation (optional, for personal use)

For a single-user vault you probably don't want to wait for confirmation emails:

1. Sidebar → **Authentication → Providers → Email**.
2. Toggle **Confirm email** → off.
3. Save.

(For a shared / multi-user setup, leave it on.)

---

## Step 5 — Get your project credentials

1. Sidebar → **Project Settings (gear icon) → API**.
2. Copy two values:
   - **Project URL** — `https://xxxxx.supabase.co`
   - **anon / public** key — long `eyJ…` string (this key is safe to embed in client code; RLS protects the data)
3. **Do NOT** copy the **service_role** key. The extension does not need it. Only ever use that on a trusted server, which we no longer have.

---

## Step 6 — Configure the extension

1. Open the extension's options page (right-click extension icon → **Options**).
2. **Storage** tab → **Active Storage Provider** → **⚡ Supabase**.
3. Paste your **Supabase URL** and **Anon Key**.
4. Click **Save Storage Settings**.

---

## Step 7 — Sign up and create your vault

1. Open the extension popup.
2. *(Optional)* If the popup doesn't yet have a "Sign up with Supabase" button visible (the auth UI for cloud providers depends on the version of the popup HTML), you can sign up once via the browser:
   - In the SQL Editor (or Authentication → Users → "Add user"), create a user with your email and a password.
3. In the popup → **Create Vault** tab → Storage Provider: **Supabase** → enter a **strong master password** → Create Vault.
4. The extension authenticates against Supabase, then writes the encrypted vault header + items to your Postgres database via PostgREST.

---

## Step 8 — Verify zero-knowledge

1. In Supabase **Table Editor**, open `vault_items`. Add a fake login item via the extension popup first.
2. Look at the `encrypted_payload` column — base64 ciphertext only.
3. Try the **SQL Editor**: `SELECT encrypted_payload FROM vault_items LIMIT 1;` — same thing. The DB never sees plaintext.
4. Test RLS: open the **SQL Editor** but switch its role from `service_role` to `anon` (top-right of the editor). Run `SELECT * FROM vault_items;` — you should get **0 rows**, because `auth.uid()` is null. RLS is working.

---

## Step 9 — Sync to a second device

1. Build the extension on the other machine, install it.
2. Configure the same Supabase URL and Anon Key.
3. Sign in with the same email/password (use the popup's sign-in flow, or pre-seed via Authentication → Users).
4. Click **Unlock**, enter your master password — vault data syncs from Postgres.

---

## Cost & quota

The free tier covers:

- 500 MB Postgres → tens of thousands of vault items
- 50,000 monthly active users → fine for a personal vault, even shared with family
- 5 GB egress / month → vault sync is tiny (kilobytes)

You'll never come close to limits with personal use. Supabase pauses free projects after 7 days of inactivity — visit the dashboard once a week or upgrade to Pro ($25/mo) if that's a problem.

---

## Backups

- Supabase has **daily automatic backups** on the free tier (retained 7 days). Project → Database → Backups.
- The vault data is *already encrypted* in the database, so a leaked backup file does not leak your passwords.
- **Always also keep a manual `.byov` export** somewhere offline — Settings → Import / Export → Export Vault. If your Supabase project is ever deleted, this file is what restores you.

---

## Troubleshooting

- **"new row violates row-level security policy"** → you're not signed in. The extension must call `signIn` before vault writes; check the Supabase Auth → Users page that your user exists.
- **`Failed to fetch`** → wrong Supabase URL or the project is paused (free tier pauses after a week of inactivity; visit the dashboard to wake it).
- **Items not syncing across devices** → confirm both devices signed in as the **same user**, and that the master password is identical.

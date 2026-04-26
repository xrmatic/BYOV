# BYOV — Google Drive setup

This is the **recommended** path. Cost: **$0**. Infrastructure to host: **none**. The extension stores a single encrypted `vault.byov` file in your Google Drive's hidden Application Data folder (invisible from drive.google.com — only this extension can see it).

You'll need:
- A Google account (any Gmail / Workspace account)
- Node.js 18+ to build the extension once
- A web browser (Chrome or Edge)

---

## Step 1 — Install Node.js

Download from <https://nodejs.org/> (the **LTS** version is fine). Install with default options. Verify in a new terminal:

```bash
node --version    # should print v18.x or higher
npm --version
```

---

## Step 2 — Build the extension

```bash
cd C:\Users\Bob\Projects\BYOV\extension
npm install
npm run build
```

This produces `extension/dist/`. **Don't load it yet** — we need the extension's ID first, which we get from a temporary install.

### 2a. Get the extension's ID

1. Open `chrome://extensions` (or `edge://extensions`).
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and pick `C:\Users\Bob\Projects\BYOV\extension\dist`.
4. The extension appears in the list with an **ID** like `mgndgikekgjfcpckkfioiadnlibdjbkf`. **Copy this ID.** You'll need it in Step 3.

> Pinning the ID: Chrome regenerates the ID every time you load the unpacked extension on a different machine. To freeze it, see "Pinning the extension ID" at the bottom of this doc.

---

## Step 3 — Create a Google Cloud OAuth client

1. Go to <https://console.cloud.google.com/>. Sign in with your Google account.
2. Top bar → **Select a project → New Project**. Name it `BYOV` (or anything). Click **Create**, then make sure it's selected.
3. In the left sidebar (☰): **APIs & Services → Library**. Search for **Google Drive API**, click it, click **Enable**.
4. Sidebar → **APIs & Services → OAuth consent screen**.
   - User type: **External** → Create.
   - App name: `BYOV`
   - User support email: your email
   - Developer contact: your email
   - Click **Save and continue** through Scopes (don't add any) and Test users.
   - On the **Test users** page, click **+ Add Users** and add your own Google email. Save and continue → Back to dashboard.
   - The app stays in "Testing" mode — that's fine for personal use (no verification needed; you just can't share it publicly).
5. Sidebar → **APIs & Services → Credentials**.
   - **+ Create credentials → OAuth client ID**
   - Application type: **Chrome Extension**
   - Name: `BYOV Extension`
   - **Item ID**: paste the extension ID from Step 2a
   - Click **Create**
6. Copy the **Client ID** that appears (something like `1234-abc.apps.googleusercontent.com`). **Keep this tab open** — you'll paste it in Step 4.

---

## Step 4 — Wire up the extension

1. Open the extension popup → click ⚙ (settings icon) to open the options page (or right-click the extension icon → Options).
2. **Storage** tab → **Active Storage Provider** → choose **🗂 Google Drive**.
3. Paste the **OAuth Client ID** from Step 3 into the field.
4. Click **Save Storage Settings**.
5. Click **Authorise Google Drive →**. A browser window opens. Sign in with the Google account you added as a test user. Approve the **App Data folder** permission (this is the *only* scope BYOV requests — it cannot see your other Drive files).
6. You should see a success message.

---

## Step 5 — Create your vault

1. Open the extension popup. You'll see the auth screen.
2. Switch to the **Create Vault** tab.
3. Choose a **strong master password** — this is the one and only thing standing between an attacker and your vault. Pick something long (≥ 16 chars) and unique. **Write it down somewhere safe.** If you lose it, your vault is unrecoverable by design.
4. Storage Provider: **Google Drive**.
5. Click **Create Vault**. The encrypted `vault.byov` is uploaded to your Drive's appdata folder.

---

## Step 6 — Verify zero-knowledge

A quick sanity check that the cloud sees only ciphertext:

1. Add one fake login item (e.g. URL: `https://example.com`, password: `correct horse battery staple`).
2. Open <https://script.google.com/> → New Project → paste:
   ```js
   function listAppData() {
     const files = Drive.Files.list({ spaces: 'appDataFolder' }).items;
     for (const f of files) {
       const blob = DriveApp.getFileById(f.id).getBlob();
       Logger.log(blob.getDataAsString().slice(0, 500));
     }
   }
   ```
   Enable **Drive API** in services. Run.
3. The output will show a JSON blob with `wrapped_vault_key`, base64 ciphertext, and zero plaintext. Your password is nowhere to be seen.

---

## Step 7 — Sync to a second device

1. On the second machine: install Node, run `npm install && npm run build`.
2. Load `extension/dist/` as unpacked **and use the same extension ID** (see "Pinning the extension ID" below — Google's OAuth client is locked to the ID you registered).
3. Configure the same Google Client ID in the options page.
4. Authorise → it'll fetch the existing `vault.byov` from your Drive.
5. Click **Unlock**, enter your master password — done.

---

## Backups

- **Manual:** Settings → **Import / Export → Export Vault (.byov)**. Save the file somewhere safe (the file is encrypted, so even an unsecured backup is fine).
- **Automatic:** Google Drive itself versions your `vault.byov` for 30 days; you can roll back via the Drive API if you ever overwrite it badly. (Not visible in the regular Drive UI because appdata files are hidden.)

---

## Pinning the extension ID

By default Chrome derives the extension ID from a randomly generated key when you `Load unpacked`. To freeze the ID across machines (so the same Google OAuth client works everywhere):

1. On any one machine where the extension is loaded and working, open `chrome://extensions`, find BYOV, click **Details**, scroll to **Source**, and locate the unpacked path.
2. Open `extension/dist/manifest.json` and add a `"key"` field with the public key the browser generated. Easier method:
   - In `chrome://extensions`, click **Pack extension** → choose `extension/dist` as the root directory → click **Pack Extension**. This creates a `.crx` and `.pem`.
   - Run: `openssl rsa -in dist.pem -pubout -outform DER | openssl base64 -A` (Git Bash on Windows) and paste the result as `"key": "..."` in the top level of `manifest.json`.
   - Rebuild (`npm run build`) — every machine that loads this dist will now get the **same** extension ID.

If you only ever use one machine, skip this. Just register the Client ID against whatever ID Chrome assigned.

---

## Troubleshooting

- **"Error: invalid_client"** when authorising → the Client ID's registered Item ID doesn't match this extension's ID. Re-check `chrome://extensions`.
- **Authorise opens then fails silently** → make sure your Google account is on the **Test users** list in the OAuth consent screen.
- **"Google Drive read failed: HTTP 403"** → token expired and refresh failed. Re-run the Authorise flow.
- **Where is `vault.byov`?** Hidden in the appdata folder. Use the Apps Script snippet in Step 6 to inspect it.

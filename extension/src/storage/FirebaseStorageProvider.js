/**
 * FirebaseStorageProvider
 *
 * Stores encrypted vault data in Firebase Firestore.
 * Uses Firebase Authentication for user identity.
 *
 * Firestore structure:
 *   vaults/{userId}/header    (document)
 *   vaults/{userId}/items/{itemId} (sub-collection)
 *
 * Required config:
 *   { apiKey, authDomain, projectId, storageBucket, messagingSenderId, appId }
 */

import { StorageProvider } from './StorageProvider.js';
import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  setDoc,
  getDoc,
  deleteDoc,
  collection,
  query,
  where,
  getDocs,
  serverTimestamp,
  orderBy,
  limit,
} from 'firebase/firestore';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  GoogleAuthProvider,
  signInWithPopup,
} from 'firebase/auth';

export class FirebaseStorageProvider extends StorageProvider {
  constructor() {
    super();
    this._app = null;
    this._db  = null;
    this._auth = null;
  }

  get name() { return 'Firebase'; }
  get type() { return 'firebase'; }

  async connect(config) {
    // Reuse an existing Firebase app if already initialised
    this._app  = getApps().length ? getApp() : initializeApp(config);
    this._db   = getFirestore(this._app);
    this._auth = getAuth(this._app);
  }

  async disconnect() {
    if (this._auth) {
      await signOut(this._auth);
    }
  }

  // ── Auth helpers (exposed for UI layer) ─────────────────────────────────────

  async signIn(email, password) {
    this._assertConnected();
    return signInWithEmailAndPassword(this._auth, email, password);
  }

  async signInWithGoogle() {
    this._assertConnected();
    const provider = new GoogleAuthProvider();
    return signInWithPopup(this._auth, provider);
  }

  async signUp(email, password) {
    this._assertConnected();
    return createUserWithEmailAndPassword(this._auth, email, password);
  }

  async signOutUser() {
    this._assertConnected();
    return signOut(this._auth);
  }

  getCurrentUser() {
    this._assertConnected();
    return this._auth.currentUser;
  }

  onAuthChange(callback) {
    this._assertConnected();
    return onAuthStateChanged(this._auth, callback);
  }

  // ── StorageProvider interface ────────────────────────────────────────────────

  async saveVaultHeader(userId, header) {
    this._assertConnected();
    const ref = doc(this._db, 'vaults', userId, 'meta', 'header');
    await setDoc(ref, { ...header, updated_at: serverTimestamp() });
  }

  async loadVaultHeader(userId) {
    this._assertConnected();
    const ref = doc(this._db, 'vaults', userId, 'meta', 'header');
    const snap = await getDoc(ref);
    return snap.exists() ? snap.data() : null;
  }

  async saveItem(userId, item) {
    this._assertConnected();
    const ref = doc(this._db, 'vaults', userId, 'items', item.id);
    await setDoc(ref, { ...item, updated_at: serverTimestamp() });
  }

  async deleteItem(userId, itemId) {
    this._assertConnected();
    // Soft-delete: retain the document for sync tombstone
    const ref = doc(this._db, 'vaults', userId, 'items', itemId);
    await setDoc(ref, { deleted: true, updated_at: serverTimestamp() }, { merge: true });
  }

  async getChanges(userId, since = 'version_0') {
    this._assertConnected();
    const colRef = collection(this._db, 'vaults', userId, 'items');

    let q;
    if (since && since !== 'version_0') {
      const sinceDate = this._sinceTokenToDate(since);
      q = query(colRef, where('updated_at', '>', sinceDate), orderBy('updated_at'));
    } else {
      q = query(colRef, orderBy('updated_at'));
    }

    const snap = await getDocs(q);
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const syncToken = `version_${Date.now()}`;
    return { items, syncToken };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  _assertConnected() {
    if (!this._db) throw new Error('FirebaseStorageProvider: call connect() first.');
  }

  _sinceTokenToDate(token) {
    const match = token.match(/version_(\d+)/);
    if (!match) return new Date(0);
    return new Date(parseInt(match[1], 10));
  }
}

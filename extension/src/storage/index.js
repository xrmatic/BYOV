/**
 * Storage Provider Factory
 *
 * Central registry of all available storage providers.
 * Import this file to get a provider by type string.
 *
 * Adding a new provider:
 *   1. Create a new class in its own file extending StorageProvider.
 *   2. Import it here and add it to the PROVIDERS map.
 *   3. The UI will automatically discover it.
 */

import { LocalStorageProvider }     from './LocalStorageProvider.js';
import { FirebaseStorageProvider }  from './FirebaseStorageProvider.js';
import { SupabaseStorageProvider }  from './SupabaseStorageProvider.js';
import { OneDriveStorageProvider }  from './OneDriveStorageProvider.js';
import { GoogleDriveStorageProvider } from './GoogleDriveStorageProvider.js';
import { DropboxStorageProvider }   from './DropboxStorageProvider.js';

/**
 * Registry of all built-in storage provider classes, keyed by type string.
 * @type {Record<string, new () => import('./StorageProvider.js').StorageProvider>}
 */
export const PROVIDERS = {
  local:       LocalStorageProvider,
  firebase:    FirebaseStorageProvider,
  supabase:    SupabaseStorageProvider,
  onedrive:    OneDriveStorageProvider,
  googledrive: GoogleDriveStorageProvider,
  dropbox:     DropboxStorageProvider,
};

/**
 * Creates a new, un-connected instance of the given provider type.
 *
 * @param {string} type – one of 'local' | 'firebase' | 'supabase' | 'onedrive' | 'googledrive' | 'dropbox'
 * @returns {import('./StorageProvider.js').StorageProvider}
 * @throws {Error} if the type is unknown
 */
export function createProvider(type) {
  const Cls = PROVIDERS[type];
  if (!Cls) {
    throw new Error(
      `Unknown storage provider type: "${type}". ` +
      `Available types: ${Object.keys(PROVIDERS).join(', ')}`,
    );
  }
  return new Cls();
}

/**
 * Returns an array of provider metadata objects for use in the UI.
 * @returns {{ type: string, name: string }[]}
 */
export function listProviders() {
  return Object.values(PROVIDERS).map((Cls) => {
    const instance = new Cls();
    return { type: instance.type, name: instance.name };
  });
}

export { StorageProvider } from './StorageProvider.js';

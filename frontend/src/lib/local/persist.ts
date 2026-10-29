/**
 * Sauvegarde locale (IndexedDB) du mode navigateur : métadonnées des projets
 * et fichiers (vidéo source, Shorts rendus, vignettes, SRT). Rien ne quitte
 * l'appareil. Survit aux rechargements de page, que Safari déclenche seul
 * sur iPad quand la mémoire manque.
 */
const DB = "viralcut";
const VERSION = 1;

let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("state")) d.createObjectStore("state");
      if (!d.objectStoreNames.contains("blobs")) d.createObjectStore("blobs");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return db().then((d) => new Promise<T | undefined>((resolve, reject) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => resolve(r ? (r as IDBRequest<T>).result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const loadState = <T>() => tx<T>("state", "readonly", (s) => s.get("snapshot")).catch(() => undefined);
export const saveState = (v: unknown) => tx("state", "readwrite", (s) => { s.put(v, "snapshot"); });
export const putBlob = (key: string, b: Blob) => tx("blobs", "readwrite", (s) => { s.put(b, key); });
export const getBlob = (key: string) => tx<Blob>("blobs", "readonly", (s) => s.get(key)).catch(() => undefined);
export const deleteBlobs = (prefix: string) =>
  tx("blobs", "readwrite", (s) => { s.delete(IDBKeyRange.bound(prefix, prefix + "￿")); });

/** Demande au navigateur de ne pas effacer ces données en cas de manque de place. */
export function requestPersistence() {
  try { void navigator.storage?.persist?.(); } catch { /* non pris en charge */ }
}

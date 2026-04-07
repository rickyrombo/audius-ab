/**
 * IndexedDB cache for decoded audio ArrayBuffers and waveform color data.
 * Keyed by stream URL so reloads skip fetch + decode + analysis.
 * FIFO eviction: keeps at most MAX_ENTRIES per store.
 */

import type { WaveformColorData } from './waveformAnalysis'

const DB_NAME = 'audius-ab-cache'
const DB_VERSION = 2
const AUDIO_STORE = 'audio'
const WAVEFORM_STORE = 'waveforms'
const MAX_ENTRIES = 8

interface CacheEntry<T> {
  value: T
  ts: number
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      // Delete old stores from v1 (no ts index)
      for (const name of [AUDIO_STORE, WAVEFORM_STORE]) {
        if (db.objectStoreNames.contains(name)) {
          db.deleteObjectStore(name)
        }
        const store = db.createObjectStore(name)
        store.createIndex('ts', 'ts')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbGet<T>(db: IDBDatabase, store: string, key: string): Promise<CacheEntry<T> | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).get(key)
    req.onsuccess = () => resolve(req.result as CacheEntry<T> | undefined)
    req.onerror = () => reject(req.error)
  })
}

function idbPut(db: IDBDatabase, store: string, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** Evict oldest entries if store has more than MAX_ENTRIES */
function evict(db: IDBDatabase, storeName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    const countReq = store.count()
    countReq.onsuccess = () => {
      const excess = countReq.result - MAX_ENTRIES
      if (excess <= 0) { resolve(); return }
      // Walk oldest-first via ts index and delete excess
      const idx = store.index('ts')
      let deleted = 0
      const cursor = idx.openCursor()
      cursor.onsuccess = () => {
        const c = cursor.result
        if (!c || deleted >= excess) { return }
        c.delete()
        deleted++
        c.continue()
      }
    }
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

let dbPromise: Promise<IDBDatabase> | null = null
function getDB(): Promise<IDBDatabase> {
  if (!dbPromise) dbPromise = openDB()
  return dbPromise
}

export async function getCachedAudio(url: string): Promise<ArrayBuffer | undefined> {
  try {
    const db = await getDB()
    const entry = await idbGet<ArrayBuffer>(db, AUDIO_STORE, url)
    return entry?.value
  } catch {
    return undefined
  }
}

export async function setCachedAudio(url: string, data: ArrayBuffer): Promise<void> {
  try {
    const db = await getDB()
    await idbPut(db, AUDIO_STORE, url, { value: data, ts: Date.now() })
    await evict(db, AUDIO_STORE)
  } catch {
    // Cache write failure is non-critical
  }
}

export async function getCachedWaveform(url: string): Promise<WaveformColorData | undefined> {
  try {
    const db = await getDB()
    const entry = await idbGet<WaveformColorData>(db, WAVEFORM_STORE, url)
    return entry?.value
  } catch {
    return undefined
  }
}

export async function setCachedWaveform(url: string, data: WaveformColorData): Promise<void> {
  try {
    const db = await getDB()
    await idbPut(db, WAVEFORM_STORE, url, { value: data, ts: Date.now() })
    await evict(db, WAVEFORM_STORE)
  } catch {
    // Cache write failure is non-critical
  }
}

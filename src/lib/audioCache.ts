/**
 * IndexedDB cache for decoded audio ArrayBuffers and waveform color data.
 * Keyed by stream URL so reloads skip fetch + decode + analysis.
 */

import type { WaveformColorData } from './waveformAnalysis'

const DB_NAME = 'audius-ab-cache'
const DB_VERSION = 1
const AUDIO_STORE = 'audio'
const WAVEFORM_STORE = 'waveforms'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(AUDIO_STORE)) {
        db.createObjectStore(AUDIO_STORE)
      }
      if (!db.objectStoreNames.contains(WAVEFORM_STORE)) {
        db.createObjectStore(WAVEFORM_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbGet<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
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

let dbPromise: Promise<IDBDatabase> | null = null
function getDB(): Promise<IDBDatabase> {
  if (!dbPromise) dbPromise = openDB()
  return dbPromise
}

export async function getCachedAudio(url: string): Promise<ArrayBuffer | undefined> {
  try {
    const db = await getDB()
    return await idbGet<ArrayBuffer>(db, AUDIO_STORE, url)
  } catch {
    return undefined
  }
}

export async function setCachedAudio(url: string, data: ArrayBuffer): Promise<void> {
  try {
    const db = await getDB()
    await idbPut(db, AUDIO_STORE, url, data)
  } catch {
    // Cache write failure is non-critical
  }
}

export async function getCachedWaveform(url: string): Promise<WaveformColorData | undefined> {
  try {
    const db = await getDB()
    return await idbGet<WaveformColorData>(db, WAVEFORM_STORE, url)
  } catch {
    return undefined
  }
}

export async function setCachedWaveform(url: string, data: WaveformColorData): Promise<void> {
  try {
    const db = await getDB()
    await idbPut(db, WAVEFORM_STORE, url, data)
  } catch {
    // Cache write failure is non-critical
  }
}

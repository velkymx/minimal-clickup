// Local cache for slow-changing ClickUp data (task list, task details, DM
// labels). Views render from here; the API is only called when nothing is
// cached yet or the user clicks "Refresh ClickUp".
// IndexedDB, not localStorage: task details + comments outgrow the ~5MB cap.
// Every call degrades to "no cache" if IndexedDB is unavailable or blocked.

const DB_NAME = 'clickupchat'
const STORE = 'taskCache'

export interface Cached<T> {
  savedAt: number
  data: T
}

let dbPromise: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      dbPromise = null
      reject(req.error)
    }
  })
  return dbPromise
}

async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const store = (await db()).transaction(STORE, mode).objectStore(STORE)
  return new Promise((resolve, reject) => {
    const req = op(store)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function readCache<T>(key: string): Promise<Cached<T> | null> {
  try {
    return (await run<Cached<T> | undefined>('readonly', (s) => s.get(key))) ?? null
  } catch {
    return null
  }
}

export async function writeCache<T>(key: string, data: T): Promise<void> {
  try {
    // JSON round-trip strips Vue proxies, which IndexedDB can't clone.
    const entry: Cached<T> = { savedAt: Date.now(), data: JSON.parse(JSON.stringify(data)) }
    await run('readwrite', (s) => s.put(entry, key))
  } catch {
    /* cache is best-effort */
  }
}

export async function clearCache(): Promise<void> {
  try {
    await run('readwrite', (s) => s.clear())
  } catch {
    /* nothing cached */
  }
}

// v6: rows gained estimate (time estimate, ms); older entries are ignored.
export const listCacheKey = (workspaceId: string, userId: string) => `list:v6:${workspaceId}:${userId}`
export const taskCacheKey = (taskId: string) => `task:${taskId}`

/** "just now", "4m ago", "2h ago", "3d ago". */
export function ageLabel(savedAt: number, now = Date.now()): string {
  const min = Math.floor((now - savedAt) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

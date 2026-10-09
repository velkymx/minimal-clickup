import { reactive, readonly, watch } from 'vue'
import { getAssignedTasks } from '../lib/clickup'
import { listCacheKey, readCache, writeCache } from '../lib/taskCache'
import { stageOf } from '../lib/workflow'
import type { ClickUpTask, TaskRow } from '../types'
import { useChat } from './useChat'

export const PRIORITY_RANK: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 }

// Module-level: the table and the dashboard share one list and one cache read.
const state = reactive({
  rows: [] as TaskRow[],
  /** When `rows` was last fetched from ClickUp (0 = never). */
  fetchedAt: 0,
  loading: false,
  /** True once the cache (or a first fetch) has populated `rows`. */
  loaded: false,
  error: '',
})

let loadPromise: Promise<void> | null = null

function toRow(task: ClickUpTask): TaskRow {
  const priority = task.priority?.priority ?? ''
  return {
    id: task.id,
    taskId: task.custom_id ?? task.id,
    name: task.name,
    url: task.url,
    status: task.status.status,
    statusColor: task.status.color,
    statusType: task.status.type,
    stage: stageOf(task.status.status, task.status.type),
    priority,
    priorityRank: PRIORITY_RANK[priority] ?? 5,
    due: task.due_date ? Number(task.due_date) : null,
    created: Number(task.date_created),
    updated: Number(task.date_updated),
    list: task.list.name,
    lists: [task.list.name, ...task.locations.map((l) => l.name)],
  }
}

export function useMyTasks() {
  const { state: chat } = useChat()
  const cacheKey = () => listCacheKey(chat.workspaceId, chat.me?.id ?? '')

  /** Pull the list from ClickUp and replace the cache. */
  async function refreshFromClickUp() {
    if (!chat.me) return
    state.loading = true
    state.error = ''
    try {
      const tasks = await getAssignedTasks(chat.workspaceId, chat.me.id)
      state.rows = tasks.map(toRow)
      state.fetchedAt = Date.now()
      state.loaded = true
      await writeCache(cacheKey(), state.rows)
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e)
    } finally {
      state.loading = false
    }
  }

  /** Render from cache; only hit ClickUp when nothing is cached yet. */
  function ensureLoaded(): Promise<void> {
    loadPromise ??= (async () => {
      const cached = await readCache<TaskRow[]>(cacheKey())
      if (cached) {
        state.rows = cached.data.map((r) => ({ ...r, stage: stageOf(r.status, r.statusType) }))
        state.fetchedAt = cached.savedAt
        state.loaded = true
      } else {
        await refreshFromClickUp()
      }
    })()
    return loadPromise
  }

  return { tasks: readonly(state), ensureLoaded, refreshFromClickUp }
}

// Sign-out: forget the in-memory list too (useChat clears the IndexedDB cache).
watch(
  () => useChat().state.ready,
  (ready) => {
    if (ready) return
    state.rows = []
    state.fetchedAt = 0
    state.loaded = false
    state.error = ''
    loadPromise = null
  },
)

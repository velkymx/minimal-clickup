import { reactive, readonly, watch } from 'vue'
import { getAssignedTasks, getCompletedTasks, getListTasks } from '../lib/clickup'
import { listCacheKey, readCache, writeCache } from '../lib/taskCache'
import { stageOf } from '../lib/workflow'
import type { ClickUpTask, TaskRow } from '../types'
import { useChat } from './useChat'

export const PRIORITY_RANK: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 }

/** Completed-task window: covers the whole current (two-week) sprint. */
const COMPLETED_LOOKBACK_MS = 31 * 24 * 60 * 60 * 1000

// Module-level: the table and the dashboard share one list and one cache read.
const state = reactive({
  /** Tasks assigned to me (subtasks included). */
  rows: [] as TaskRow[],
  /** Subtasks of my tasks (any depth) assigned to someone else. */
  subtasks: [] as TaskRow[],
  /** My tasks completed in the last COMPLETED_LOOKBACK_MS, closed included. */
  completed: [] as TaskRow[],
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
    parentId: task.parent ?? null,
    estimate: task.time_estimate ?? null,
  }
}

/**
 * Descendants of my tasks that aren't mine. The API can't fetch subtasks for
 * many parents at once, so this scans the open tasks of every list my tasks
 * live in (subtasks share their parent's list).
 */
async function fetchOthersSubtasks(workspaceId: string, mine: ClickUpTask[]): Promise<ClickUpTask[]> {
  const listIds = [...new Set(mine.map((t) => t.list.id))]
  if (!listIds.length) return []
  const childrenOf = new Map<string, ClickUpTask[]>()
  for (const task of await getListTasks(workspaceId, listIds)) {
    if (task.parent) childrenOf.set(task.parent, [...(childrenOf.get(task.parent) ?? []), task])
  }
  const seen = new Set(mine.map((t) => t.id))
  const queue = [...seen]
  const others: ClickUpTask[] = []
  while (queue.length) {
    for (const child of childrenOf.get(queue.pop()!) ?? []) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      others.push(child)
      queue.push(child.id)
    }
  }
  return others
}

export function useMyTasks() {
  const { state: chat } = useChat()
  const cacheKey = () => listCacheKey(chat.workspaceId, chat.me?.id ?? '')
  const subtasksCacheKey = () => `${cacheKey()}:subtasks`
  const completedCacheKey = () => `${cacheKey()}:completed`

  /** Pull the list from ClickUp and replace the cache. */
  async function refreshFromClickUp() {
    if (!chat.me) return
    state.loading = true
    state.error = ''
    try {
      const [tasks, completed] = await Promise.all([
        getAssignedTasks(chat.workspaceId, chat.me.id),
        getCompletedTasks(chat.workspaceId, chat.me.id, Date.now() - COMPLETED_LOOKBACK_MS),
      ])
      const others = await fetchOthersSubtasks(chat.workspaceId, tasks)
      state.rows = tasks.map(toRow)
      state.subtasks = others.map(toRow)
      state.completed = completed.map(toRow)
      state.fetchedAt = Date.now()
      state.loaded = true
      await writeCache(cacheKey(), state.rows)
      await writeCache(subtasksCacheKey(), state.subtasks)
      await writeCache(completedCacheKey(), state.completed)
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
        const restore = (r: TaskRow): TaskRow => ({ ...r, stage: stageOf(r.status, r.statusType) })
        state.rows = cached.data.map(restore)
        state.subtasks = (await readCache<TaskRow[]>(subtasksCacheKey()))?.data.map(restore) ?? []
        state.completed = (await readCache<TaskRow[]>(completedCacheKey()))?.data.map(restore) ?? []
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
    state.subtasks = []
    state.completed = []
    state.fetchedAt = 0
    state.loaded = false
    state.error = ''
    loadPromise = null
  },
)

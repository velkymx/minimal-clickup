import type {
  ClickUpTask,
  ClickUpTaskDetail,
  TaskComment,
  ChatChannel,
  ChatMessage,
  ChatReaction,
  Member,
  Paged,
  Workspace,
  WorkspaceUser,
} from '../types'

import { reactive } from 'vue'

// Proxied through Vite dev server (see vite.config.ts) to avoid CORS.
const BASE = '/clickup/api'

export class ClickUpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// ---------- Built-in observability ----------
// Every API call is recorded here so failures are diagnosable in-app
// (debug panel) without DevTools.

export interface ApiLogEntry {
  ts: number
  method: string
  path: string
  status: number | null
  ms: number
  error?: string
}

const API_LOG_MAX = 100

export const apiLog = reactive<ApiLogEntry[]>([])

export const apiHealth = reactive({
  consecutiveFailures: 0,
  lastOkAt: 0,
  lastError: '',
  lastErrorAt: 0,
})

function record(entry: ApiLogEntry) {
  apiLog.unshift(entry)
  if (apiLog.length > API_LOG_MAX) apiLog.length = API_LOG_MAX
  if (entry.error) {
    apiHealth.consecutiveFailures++
    apiHealth.lastError = `${entry.method} ${entry.path} → ${entry.error}`
    apiHealth.lastErrorAt = entry.ts
    console.error(`[clickup] ${entry.method} ${entry.path} failed after ${entry.ms}ms:`, entry.error)
  } else {
    apiHealth.consecutiveFailures = 0
    apiHealth.lastOkAt = entry.ts
  }
}

/** Requests that hang (dead proxy socket, stalled connection) abort here. */
const REQUEST_TIMEOUT_MS = 15_000

let apiToken = ''

export function setToken(token: string) {
  apiToken = token.trim()
}

const RETRY_DELAY_MS = 700

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
  attempt = 0,
): Promise<T> {
  const method = init.method ?? 'GET'
  const started = Date.now()
  const done = (status: number | null, error?: string) =>
    record({ ts: started, method, path, status, ms: Date.now() - started, error })

  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: apiToken,
        'Content-Type': 'application/json',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e) {
    // Network-level failure: timeout, dead proxy socket, DNS, offline.
    const reason =
      e instanceof DOMException && e.name === 'TimeoutError'
        ? `timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
        : 'network error'
    done(null, reason)
    if (method === 'GET' && attempt < 1) {
      await sleep(RETRY_DELAY_MS)
      return request<T>(path, init, attempt + 1)
    }
    throw new ClickUpError(0, `ClickUp unreachable (${reason}) — try again.`)
  }

  if (!res.ok) {
    // Transient 5xx (ClickUp burst errors, proxy resets) — retry GETs once.
    if (res.status >= 500 && method === 'GET' && attempt < 1) {
      done(res.status, `HTTP ${res.status} (retrying)`)
      await sleep(RETRY_DELAY_MS)
      return request<T>(path, init, attempt + 1)
    }
    let detail = res.statusText
    try {
      const err = await res.json()
      detail = err.err ?? err.error ?? err.message ?? detail
    } catch {
      /* non-JSON error body */
    }
    done(res.status, detail)
    throw new ClickUpError(res.status, detail)
  }

  if (res.status === 204) {
    done(res.status)
    return undefined as T
  }
  try {
    const json = (await res.json()) as T
    done(res.status)
    return json
  } catch {
    // ClickUp occasionally returns 200 with an empty/garbled body.
    done(res.status, 'unparseable body')
    if (method === 'GET' && attempt < 1) {
      await sleep(RETRY_DELAY_MS)
      return request<T>(path, init, attempt + 1)
    }
    throw new ClickUpError(502, 'Invalid response from ClickUp — try again.')
  }
}

function pageData<T>(page: Paged<T> | T[] | undefined): T[] {
  if (!page) return []
  if (Array.isArray(page)) return page
  return page.data ?? []
}

// ---------- v2: identity + workspace roster ----------

export async function getCurrentUser(): Promise<WorkspaceUser> {
  const res = await request<{ user: WorkspaceUser }>('/v2/user')
  return res.user
}

export async function getWorkspaces(): Promise<Workspace[]> {
  const res = await request<{ teams: Workspace[] }>('/v2/team')
  return res.teams ?? []
}

export function toMember(user: WorkspaceUser): Member {
  return {
    id: String(user.id),
    username: user.username || user.email || `user-${user.id}`,
    color: user.color || '#7b68ee',
    profilePicture: user.profilePicture ?? null,
    initials:
      user.initials ||
      (user.username || '?')
        .split(/\s+/)
        .map((part) => part[0])
        .join('')
        .slice(0, 2)
        .toUpperCase(),
  }
}

// ---------- v2: Tasks ----------

/** Every open task (subtasks included) assigned to `userId`. The endpoint
 *  pages at 100 tasks; walk pages until `last_page`. */
export async function getAssignedTasks(
  workspaceId: string,
  userId: string,
): Promise<ClickUpTask[]> {
  const tasks: ClickUpTask[] = []
  for (let page = 0; ; page++) {
    const res = await request<{ tasks: ClickUpTask[]; last_page?: boolean }>(
      `/v2/team/${workspaceId}/task?assignees[]=${userId}&subtasks=true&page=${page}`,
    )
    tasks.push(...res.tasks)
    if (res.last_page || !res.tasks.length) return tasks
  }
}

export async function getTask(taskId: string): Promise<ClickUpTaskDetail> {
  return request<ClickUpTaskDetail>(
    `/v2/task/${taskId}?include_markdown_description=true&include_subtasks=true`,
  )
}

/** Top-level comments, newest first (the API's order). */
export async function getTaskComments(taskId: string): Promise<TaskComment[]> {
  const res = await request<{ comments: TaskComment[] }>(`/v2/task/${taskId}/comment`)
  return res.comments ?? []
}

/** Threaded replies under a comment. */
export async function getCommentReplies(commentId: string): Promise<TaskComment[]> {
  const res = await request<{ comments: TaskComment[] }>(`/v2/comment/${commentId}/reply`)
  return res.comments ?? []
}

// ---------- v3: Chat ----------

export async function getChannels(workspaceId: string): Promise<ChatChannel[]> {
  const res = await request<Paged<ChatChannel>>(
    `/v3/workspaces/${workspaceId}/chat/channels?limit=100`,
  )
  return pageData(res)
}

export async function getChannelMembers(
  workspaceId: string,
  channelId: string,
): Promise<WorkspaceUser[]> {
  const res = await request<Paged<WorkspaceUser>>(
    `/v3/workspaces/${workspaceId}/chat/channels/${channelId}/members?limit=20`,
  )
  return pageData(res)
}

export async function getMessages(
  workspaceId: string,
  channelId: string,
  limit = 50,
): Promise<ChatMessage[]> {
  const res = await request<Paged<ChatMessage>>(
    `/v3/workspaces/${workspaceId}/chat/channels/${channelId}/messages?limit=${limit}`,
  )
  return pageData(res)
}

export async function sendMessage(
  workspaceId: string,
  channelId: string,
  content: string,
): Promise<ChatMessage> {
  const res = await request<{ data?: ChatMessage } & ChatMessage>(
    `/v3/workspaces/${workspaceId}/chat/channels/${channelId}/messages`,
    {
      method: 'POST',
      body: { type: 'message', content_format: 'text/md', content },
    },
  )
  return res.data ?? res
}

/** Reactions are NOT included in message list responses — fetch per message. */
export async function getReactions(
  workspaceId: string,
  messageId: string,
): Promise<ChatReaction[]> {
  const res = await request<Paged<ChatReaction>>(
    `/v3/workspaces/${workspaceId}/chat/messages/${messageId}/reactions`,
  )
  return pageData(res)
}

/** `reaction` is a Slack-style shortname, e.g. "+1" or "heart". */
export async function addReaction(
  workspaceId: string,
  messageId: string,
  reaction: string,
): Promise<void> {
  await request(
    `/v3/workspaces/${workspaceId}/chat/messages/${messageId}/reactions`,
    { method: 'POST', body: { reaction } },
  )
}

export async function removeReaction(
  workspaceId: string,
  messageId: string,
  reaction: string,
): Promise<void> {
  await request(
    `/v3/workspaces/${workspaceId}/chat/messages/${messageId}/reactions/${encodeURIComponent(reaction)}`,
    { method: 'DELETE' },
  )
}

export async function getReplies(
  workspaceId: string,
  messageId: string,
): Promise<ChatMessage[]> {
  const res = await request<Paged<ChatMessage>>(
    `/v3/workspaces/${workspaceId}/chat/messages/${messageId}/replies?limit=50`,
  )
  return pageData(res)
}

export async function sendReply(
  workspaceId: string,
  messageId: string,
  content: string,
): Promise<ChatMessage> {
  const res = await request<{ data?: ChatMessage } & ChatMessage>(
    `/v3/workspaces/${workspaceId}/chat/messages/${messageId}/replies`,
    {
      method: 'POST',
      body: { type: 'message', content_format: 'text/md', content },
    },
  )
  return res.data ?? res
}

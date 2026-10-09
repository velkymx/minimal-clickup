// ClickUp API types (v2 for workspace/users, v3 for Chat)

export interface Workspace {
  id: string
  name: string
  color?: string
  avatar?: string | null
  members?: Array<{ user: WorkspaceUser }>
}

export interface WorkspaceUser {
  id: number
  username: string
  email?: string
  color?: string | null
  profilePicture?: string | null
  initials?: string
}

/** Normalized member used throughout the UI (v3 chat uses string user ids). */
export interface Member {
  id: string
  username: string
  color: string
  profilePicture: string | null
  initials: string
}

export type ChannelType = 'CHANNEL' | 'DM' | 'GROUP_DM'

export interface ChatChannel {
  id: string
  name?: string
  type: ChannelType
  visibility?: 'PUBLIC' | 'PRIVATE'
  description?: string
  is_favorite?: boolean
  archived?: boolean
  /** Epoch ms of the newest message (including thread replies). */
  latest_comment_at?: number
  /** UI-only: resolved display name for DMs (member usernames). */
  displayName?: string
}

export interface ChatReaction {
  reaction: string
  date: number
  /** String in message payloads, NUMBER from the reactions endpoint. */
  user_id: string | number
}

export interface ChatMessage {
  id: string
  type: string
  user_id?: string
  content?: string
  date: number
  parent_channel?: string
  parent_message_id?: string
  replies_count?: number
  /** Not included in list responses — fetched lazily via the reactions endpoint. */
  reactions?: readonly ChatReaction[]
  links?: Record<string, string>
}

/** A message queued locally during the undo window, not yet sent to ClickUp. */
export interface PendingSend {
  id: string
  channelId: string
  /** Set when the pending message is a thread reply. */
  threadParentId?: string
  /** Markdown that will be sent. */
  content: string
  /** Original composer HTML, restored on undo. */
  html?: string
  /** Epoch ms when the message auto-sends. */
  sendAt: number
  failed?: boolean
  dispatching?: boolean
}

/** A docked chat box (LinkedIn / Google Chat style) on non-chat pages. */
export interface ChatBox {
  channelId: string
  /** Collapsed to its header bar. */
  minimized: boolean
  /** Oldest → newest, like the main pane. */
  messages: ChatMessage[]
  loading: boolean
}

// ---------- v2: Tasks ----------

export interface ClickUpTask {
  id: string
  /** Workspace task ID, e.g. "DEV-9082". Null when custom IDs are off for the space. */
  custom_id: string | null
  name: string
  url: string
  /** `type`: open | unstarted | custom | done | closed. */
  status: { status: string; color: string; type: string }
  priority: { priority: string; color: string } | null
  /** Epoch ms as a string, or null. */
  due_date: string | null
  date_created: string
  date_updated: string
  list: { id: string; name: string }
  /** Extra lists the task lives in (multi-list membership, e.g. a sprint). */
  locations: Array<{ id: string; name: string }>
  /** Parent task id when this is a subtask. */
  parent: string | null
}

export interface TaskUser {
  id: number
  username: string
  email?: string
  color?: string | null
  initials?: string
  profilePicture?: string | null
}

export interface TaskCustomField {
  id: string
  name: string
  /** drop_down, labels, users, text, short_text, email, url, phone, number,
   *  currency, date, checkbox, automatic_progress, manual_progress, tasks,
   *  location, emoji, … — formatted per type in the detail view. */
  type: string
  value?: unknown
  type_config?: {
    options?: Array<{ id: string; name?: string; label?: string; color?: string; orderindex: number }>
  }
}

export interface TaskChecklist {
  id: string
  name: string
  items: Array<{ id: string; name: string; resolved: boolean; assignee: TaskUser | null }>
}

export interface TaskAttachment {
  id: string
  title: string
  url: string
  extension?: string
  size?: number
  date: string
  user?: TaskUser
}

/** Full task from GET /v2/task/{id}?include_markdown_description&include_subtasks. */
export interface ClickUpTaskDetail extends ClickUpTask {
  markdown_description?: string
  text_content?: string
  date_closed: string | null
  start_date: string | null
  time_estimate: number | null
  time_spent: number | null
  points: number | null
  creator: TaskUser
  assignees: TaskUser[]
  watchers: TaskUser[]
  tags: Array<{ name: string; tag_bg: string; tag_fg: string }>
  checklists: TaskChecklist[]
  custom_fields: TaskCustomField[]
  /** `task_id` waits on `depends_on`. */
  dependencies: Array<{ task_id: string; depends_on: string }>
  /** The other side is whichever of task_id / link_id isn't this task. */
  linked_tasks: Array<{ task_id: string; link_id: string }>
  folder: { id: string; name: string; hidden?: boolean }
  space: { id: string }
  attachments: TaskAttachment[]
  subtasks?: ClickUpTask[]
}

export interface TaskComment {
  id: string
  comment_text: string
  user: TaskUser
  date: string
  reply_count: number
  resolved?: boolean
  /** UI-only: replies fetched for threads with reply_count > 0. */
  replies?: TaskComment[]
}

/** Flat row for the tasks table. A type alias (not interface) so it
 *  satisfies DataTableColumn's Record<string, unknown> constraint. */
export type TaskRow = {
  id: string
  /** Custom ID ("DEV-9082"), or the raw task id when the space has none. */
  taskId: string
  name: string
  url: string
  status: string
  statusColor: string
  /** ClickUp status type: open | unstarted | custom | done | closed. */
  statusType: string
  /** Workflow stage — derived from status at load time (lib/workflow.ts),
   *  never trusted from cache, so mapping edits apply without a refetch. */
  stage: Stage
  priority: string
  /** Sort rank: urgent 1 … low 4, none 5. */
  priorityRank: number
  due: number | null
  created: number
  updated: number
  list: string
  /** Home list + extra locations — used to find sprint membership. */
  lists: string[]
  /** Parent task id (subtasks only). */
  parentId: string | null
}

export type Stage =
  | 'inbox'
  | 'planning'
  | 'icebox'
  | 'backlog'
  | 'doing'
  | 'review'
  | 'blocked'
  | 'approved'
  | 'done'

export interface Paged<T> {
  data: T[]
  next_cursor?: string | null
  meta?: { next_cursor?: string | null }
}

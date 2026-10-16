import { computed, reactive, readonly } from 'vue'
import * as api from '../lib/clickup'
import { linkMentions } from '../lib/mentions'
import { clearCache, readCache, writeCache } from '../lib/taskCache'
import type {
  ChatBox,
  ChatChannel,
  ChatMessage,
  ChatThread,
  Member,
  PendingSend,
} from '../types'

const STORAGE_KEY = 'clickupchat.session'
const SOUND_KEY = 'clickupchat.sound'
const PINNED_KEY = 'clickupchat.pinned'
// v2: switched from "start clean" to a 7-day lookback baseline.
const LASTREAD_KEY = 'clickupchat.lastread.v2'

/** Open channel, thread, docked boxes and the channel list (one call). */
const MESSAGE_POLL_MS = 50_000
/** Full unread sweep with exact counts (one call per flagged channel). */
const CHANNEL_POLL_MS = 300_000
/** Exact counts for pinned channels (one call per flagged pinned channel). */
const PINNED_POLL_MS = 60_000
/** Docked boxes open at once; opening another drops the oldest. */
const MAX_BOXES = 3
/** Reactions refreshed when a box opens — boxes are small, keep it cheap. */
const BOX_REACTION_COUNT = 5
/** Channels never seen before count as unread for this much history. */
const UNREAD_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
/** Messages fetched per channel in the unread sweep — counts cap at "9+". */
const SWEEP_FETCH_LIMIT = 10
/**
 * Rate-limit guard: exact counts fetched for at most N flagged channels per
 * sweep. Channels beyond the cap still show an unread dot (from
 * latest_comment_at), just without a number.
 */
const SWEEP_COUNT_CAP = 15
/** Reactions live behind a per-message endpoint; refresh the newest N only. */
const REACTION_REFRESH_COUNT = 10

/** Sentinel for "unread, exact count unknown". */
export const UNREAD_UNKNOWN = -1

/** Undo window: queued messages wait this long before actually sending. */
export const PENDING_DELAY_MS = 60_000

interface Session {
  token: string
  workspaceId: string
  workspaceName: string
}

const state = reactive({
  ready: false,
  token: '',
  workspaceId: '',
  workspaceName: '',
  me: null as Member | null,
  members: new Map<string, Member>(),
  channels: [] as ChatChannel[],
  activeChannelId: '',
  messages: [] as ChatMessage[],
  loadingChannels: false,
  loadingMessages: false,
  error: '',
  soundOn: localStorage.getItem(SOUND_KEY) !== '0',
  /** Per-channel count of messages newer than last read (capped at 10). */
  unread: {} as Record<string, number>,
  /**
   * Last-read timestamp captured when the current channel was opened —
   * the "NEW messages" divider sits above the first message newer than this
   * and stays put until you switch channels (Discord behavior).
   */
  dividerAt: 0,
  /** Thread open in the chat page's side panel (null = closed). */
  thread: null as ChatThread | null,
  /** Locally queued messages inside their 60s undo window. */
  pending: [] as PendingSend[],
  /** 1s clock driving the pending countdowns. */
  nowTick: Date.now(),
  /** Channel ids pinned to the top of the sidebar. Persisted. */
  pinned: [] as string[],
  /** Channel the full chat page last showed — where the Chat nav link returns. */
  lastChannelId: '',
  /** True on pages that show the chat dock (everything but the chat page). */
  dockActive: false,
  /** Docked chat boxes, left → right in open order. */
  boxes: [] as ChatBox[],
})

/** Set at connect: only activity after this auto-opens a box. */
let connectedAt = 0
/** channelId → latest_comment_at when its box was closed; no reopen until newer. */
const dismissedAt: Record<string, number> = {}

try {
  state.pinned = JSON.parse(localStorage.getItem(PINNED_KEY) ?? '[]')
} catch {
  state.pinned = []
}

// channelId → epoch ms of newest message the user has seen. Persisted.
let lastRead: Record<string, number> = {}
try {
  lastRead = JSON.parse(localStorage.getItem(LASTREAD_KEY) ?? '{}')
} catch {
  lastRead = {}
}

let messageTimer: ReturnType<typeof setInterval> | undefined
let channelTimer: ReturnType<typeof setInterval> | undefined
let pendingTimer: ReturnType<typeof setInterval> | undefined
let pinnedTimer: ReturnType<typeof setInterval> | undefined

// Don't let a page close silently drop messages still in their undo window.
window.addEventListener('beforeunload', (event) => {
  if (state.pending.length) event.preventDefault()
})

function saveLastRead() {
  localStorage.setItem(LASTREAD_KEY, JSON.stringify(lastRead))
}

/** Run async work over items a few at a time — full parallel bursts trip
 *  transient 5xx errors on ClickUp's side. Failures are swallowed per item. */
async function inBatches<T>(
  items: readonly T[],
  batchSize: number,
  fn: (item: T) => Promise<unknown>,
) {
  for (let i = 0; i < items.length; i += batchSize) {
    await Promise.allSettled(items.slice(i, i + batchSize).map(fn))
  }
}

function totalUnread(): number {
  // Unknown-count channels (sentinel -1) count as one unread each.
  return Object.values(state.unread).reduce(
    (sum, n) => sum + (n === UNREAD_UNKNOWN ? 1 : n),
    0,
  )
}

/** One place drives every "you have unread" signal: favicon + tab title. */
function refreshBadges() {
  const total = totalUnread()
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (link) link.href = total ? '/favicon-unread.svg' : '/favicon.svg'
  document.title = total ? `(${total > 99 ? '99+' : total}) ClickUp Chat` : 'ClickUp Chat'
}

/**
 * Newest SERVER timestamp we can prove the user has seen for this channel: the
 * channel's `latest_comment_at` (which also covers thread replies) and the
 * newest message currently rendered for it. Always server time — never the
 * local clock — so read marks can't drift against message timestamps.
 */
function seenHighWater(channelId: string): number {
  const channel = state.channels.find((c) => c.id === channelId)
  let hw = channel?.latest_comment_at ?? 0
  const pools: ChatMessage[][] = []
  if (channelId === state.activeChannelId) pools.push(state.messages)
  const box = state.boxes.find((b) => b.channelId === channelId)
  if (box) pools.push(box.messages)
  for (const pool of pools) {
    for (const m of pool) if (m.date > hw) hw = m.date
  }
  return hw
}

function markChannelRead(channelId: string, upTo = seenHighWater(channelId)) {
  if (!channelId || !upTo) return
  if ((lastRead[channelId] ?? 0) >= upTo && !state.unread[channelId]) return
  lastRead[channelId] = Math.max(lastRead[channelId] ?? 0, upTo)
  saveLastRead()
  if (state.unread[channelId]) delete state.unread[channelId]
  refreshBadges()
}

function countUnread(channelId: string, messages: ChatMessage[]): number {
  const seen = lastRead[channelId] ?? 0
  return messages.filter(
    (m) => m.date > seen && m.user_id && m.user_id !== state.me?.id,
  ).length
}

/** An expanded box on a page that shows the dock. */
function boxVisible(box: ChatBox): boolean {
  return state.dockActive && !box.minimized
}

/** On screen right now: the full chat page's channel or an expanded box. */
function isViewing(channelId: string): boolean {
  if (document.hidden) return false
  return (
    channelId === state.activeChannelId ||
    state.boxes.some((b) => b.channelId === channelId && boxVisible(b))
  )
}

// Coming back to the tab means you've seen what's on screen.
// Read marks use "now" (not newest.date): thread replies bump the channel's
// latest_comment_at without appearing in the main list.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return
  for (const channel of state.channels) {
    if (isViewing(channel.id)) markChannelRead(channel.id)
  }
})

function beep() {
  if (!state.soundOn) return
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.08, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25)
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.25)
    osc.onended = () => ctx.close()
  } catch {
    /* audio blocked before user gesture — fine */
  }
}

function saveSession() {
  const session: Session = {
    token: state.token,
    workspaceId: state.workspaceId,
    workspaceName: state.workspaceName,
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
}

function loadSession(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Session) : null
  } catch {
    return null
  }
}

async function loadRoster() {
  const [me, workspaces] = await Promise.all([
    api.getCurrentUser(),
    api.getWorkspaces(),
  ])
  state.me = api.toMember(me)
  const ws = workspaces.find((w) => w.id === state.workspaceId)
  state.workspaceName = ws?.name ?? state.workspaceName
  state.members = new Map()
  for (const entry of ws?.members ?? []) {
    const member = api.toMember(entry.user)
    state.members.set(member.id, member)
  }
  state.members.set(state.me.id, state.me)
}

/**
 * channelId → DM label. Persisted: DM membership rarely changes, and resolving
 * labels costs one members call per DM (~40 on a cold start — enough to trip
 * ClickUp's rate limit). Only DMs missing from here are looked up.
 */
let dmNames: Record<string, string> = {}
const dmNamesKey = () => `dmNames:${state.workspaceId}`

/** DM channels come back nameless — label them with the other members' usernames. */
async function resolveDmName(channel: ChatChannel) {
  try {
    const users = await api.getChannelMembers(state.workspaceId, channel.id)
    const others = users
      .map((u) => api.toMember(u))
      .filter((m) => m.id !== state.me?.id)
    channel.displayName =
      others.map((m) => m.username).join(', ') || channel.name || 'Direct message'
    dmNames[channel.id] = channel.displayName
  } catch {
    // Not cached, so the next channel refresh retries it.
    channel.displayName = channel.name || 'Direct message'
  }
}

async function loadChannels() {
  state.loadingChannels = true
  try {
    const fresh = await api.getChannels(state.workspaceId)
    const oldNames = new Map(
      state.channels.map((c) => [c.id, c.displayName] as const),
    )
    for (const channel of fresh) {
      channel.displayName = dmNames[channel.id] ?? oldNames.get(channel.id) ?? channel.name
    }
    state.channels = fresh.filter((c) => !c.archived)
    const unresolved = state.channels.filter((c) => c.type !== 'CHANNEL' && !dmNames[c.id])
    if (unresolved.length) {
      await inBatches(unresolved, 4, resolveDmName)
      await writeCache(dmNamesKey(), dmNames)
    }
  } finally {
    state.loadingChannels = false
  }
}

/**
 * Unread sweep. Cheap pass first: every channel whose `latest_comment_at`
 * is newer than the user's last-read mark is unread — no extra requests.
 * Then exact counts are fetched for the most recently active flagged
 * channels (capped); the rest keep an unread dot without a number.
 * Chimes when the total goes up.
 */
async function sweepUnread() {
  const before = totalUnread()

  // Channels we've never tracked start with a 7-day lookback baseline.
  const baselineStart = Date.now() - UNREAD_LOOKBACK_MS
  let baselined = false
  for (const channel of state.channels) {
    if (lastRead[channel.id] === undefined) {
      lastRead[channel.id] = baselineStart
      baselined = true
    }
  }
  if (baselined) saveLastRead()

  const flagged = state.channels.filter(
    (c) => !isViewing(c.id) && (c.latest_comment_at ?? 0) > (lastRead[c.id] ?? 0),
  )
  const flaggedIds = new Set(flagged.map((c) => c.id))

  // Channels no longer flagged lose their badge (read elsewhere / stale).
  for (const id of Object.keys(state.unread)) {
    if (!flaggedIds.has(id) && !isViewing(id)) delete state.unread[id]
  }

  const byActivity = [...flagged].sort(
    (a, b) => (b.latest_comment_at ?? 0) - (a.latest_comment_at ?? 0),
  )
  await inBatches(byActivity.slice(0, SWEEP_COUNT_CAP), 4, fetchUnreadCount)
  for (const channel of byActivity.slice(SWEEP_COUNT_CAP)) {
    if (!state.unread[channel.id]) state.unread[channel.id] = UNREAD_UNKNOWN
  }

  refreshBadges()
  if (totalUnread() > before) beep()
}

/** Exact unread count for one flagged channel (one request). */
async function fetchUnreadCount(channel: ChatChannel) {
  const messages = await api.getMessages(
    state.workspaceId,
    channel.id,
    SWEEP_FETCH_LIMIT,
  )
  const count = countUnread(channel.id, messages)
  if (count) {
    state.unread[channel.id] = count
    return
  }
  // No new top-level messages from others, yet latest_comment_at moved past
  // the read mark. Two causes, told apart by the newest message we can see:
  const latest = channel.latest_comment_at ?? 0
  const newestOwn = messages.reduce(
    (max, m) => (m.user_id && m.user_id === state.me?.id && m.date > max ? m.date : max),
    0,
  )
  if (newestOwn >= latest) {
    // The latest channel activity is your OWN message (e.g. sent from the
    // ClickUp app). Not unread — advance the read mark so it stops re-flagging.
    markChannelRead(channel.id, Math.max(latest, newestOwn))
    delete state.unread[channel.id]
  } else {
    // Activity is a thread reply (bumps the timestamp without appearing in the
    // main list). Can't tell whose from the list — flag it to be safe.
    state.unread[channel.id] = UNREAD_UNKNOWN
  }
}

/**
 * Pinned channels get exact counts every minute instead of waiting for the
 * full sweep. Only flagged ones cost a request; the channel list (and so
 * `latest_comment_at`) is kept fresh by watchChannels.
 */
async function sweepPinned() {
  const before = totalUnread()
  const flagged = state.channels.filter(
    (c) =>
      state.pinned.includes(c.id) &&
      lastRead[c.id] !== undefined &&
      !isViewing(c.id) &&
      (c.latest_comment_at ?? 0) > lastRead[c.id],
  )
  await inBatches(flagged, 4, fetchUnreadCount)
  refreshBadges()
  if (totalUnread() > before) beep()
}

/**
 * Cheap unread pass between sweeps — no extra requests. Channels whose
 * `latest_comment_at` moved past the read mark get a dot; the next full
 * sweep fills in exact counts. Chimes when something new turns up.
 */
function flagUnread() {
  const before = totalUnread()
  for (const channel of state.channels) {
    const seen = lastRead[channel.id]
    // Untracked channels get their baseline from the next full sweep.
    if (seen === undefined || isViewing(channel.id) || state.unread[channel.id]) continue
    if ((channel.latest_comment_at ?? 0) > seen) state.unread[channel.id] = UNREAD_UNKNOWN
  }
  refreshBadges()
  if (totalUnread() > before) beep()
}

// ---------- Docked chat boxes ----------

/** DMs and pinned channels pop a box when someone writes in them. */
function autoOpens(channel: ChatChannel): boolean {
  return channel.type !== 'CHANNEL' || state.pinned.includes(channel.id)
}

async function pollBox(channelId: string) {
  const box = state.boxes.find((b) => b.channelId === channelId)
  if (!box) return
  const fresh = await api.getMessages(state.workspaceId, channelId)
  fresh.reverse() // oldest → newest
  const known = new Set(box.messages.map((m) => m.id))
  const hasForeignNew =
    known.size > 0 &&
    fresh.some((m) => !known.has(m.id) && m.user_id && m.user_id !== state.me?.id)
  // List responses omit reactions — carry over the lazily-fetched ones.
  const prevReactions = new Map(box.messages.map((m) => [m.id, m.reactions] as const))
  for (const m of fresh) {
    if (!m.reactions?.length) m.reactions = prevReactions.get(m.id) ?? m.reactions
  }
  box.messages = fresh
  // Hidden/minimized boxes chime through flagUnread instead.
  if (isViewing(channelId)) {
    if (hasForeignNew) beep()
    markChannelRead(channelId)
  }
  const thread = box.thread
  if (thread) {
    refreshParent(thread, fresh)
    await loadReplies(thread)
  }
}

/** Open (or expand) a docked box. Opening past the cap drops the oldest. */
async function openBox(channelId: string) {
  const existing = state.boxes.find((b) => b.channelId === channelId)
  if (existing) {
    expandBox(existing)
    return
  }
  state.boxes.push({ channelId, minimized: false, messages: [], loading: true, thread: null })
  if (state.boxes.length > MAX_BOXES) state.boxes.shift()
  const box = state.boxes.find((b) => b.channelId === channelId)
  try {
    await pollBox(channelId)
  } finally {
    if (box) box.loading = false
  }
  const recent = box?.messages.slice(-BOX_REACTION_COUNT) ?? []
  inBatches(recent, 4, (m) => refreshReactionsFor(m.id)).catch(() => {})
}

function expandBox(box: ChatBox) {
  box.minimized = false
  if (isViewing(box.channelId)) markChannelRead(box.channelId)
}

/**
 * Pop boxes for DMs / pinned channels with new activity since connect.
 * Checks the actual messages first so your own activity (sent from another
 * ClickUp client) and thread-only replies don't pop a box.
 */
async function autoOpenBoxes() {
  if (!state.dockActive) return
  const candidates = state.channels.filter((c) => {
    const latest = c.latest_comment_at ?? 0
    return (
      autoOpens(c) &&
      latest > connectedAt &&
      latest > (lastRead[c.id] ?? Infinity) &&
      latest > (dismissedAt[c.id] ?? 0) &&
      !state.boxes.some((b) => b.channelId === c.id)
    )
  })
  await inBatches(candidates, 4, async (channel) => {
    const messages = await api.getMessages(state.workspaceId, channel.id, SWEEP_FETCH_LIMIT)
    if (countUnread(channel.id, messages)) {
      await openBox(channel.id)
    } else {
      dismissedAt[channel.id] = channel.latest_comment_at ?? Date.now()
    }
  })
}

/** Frequent pass: channel list, unread dots, docked boxes. */
async function watchChannels() {
  await loadChannels()
  flagUnread()
  await Promise.all([
    autoOpenBoxes(),
    state.dockActive
      ? inBatches(state.boxes, 3, (b) => pollBox(b.channelId))
      : Promise.resolve(),
  ])
}

async function pollMessages() {
  if (!state.activeChannelId) return
  const channelId = state.activeChannelId
  const fresh = await api.getMessages(state.workspaceId, channelId)
  if (channelId !== state.activeChannelId) return // switched mid-flight
  // API returns newest first; UI renders oldest → newest.
  fresh.reverse()
  const known = new Set(state.messages.map((m) => m.id))
  const incoming = fresh.filter((m) => !known.has(m.id))
  const hasForeignNew = incoming.some(
    (m) => m.user_id && m.user_id !== state.me?.id,
  )
  // List responses omit reactions — carry over the lazily-fetched ones.
  const prevReactions = new Map(
    state.messages.map((m) => [m.id, m.reactions] as const),
  )
  for (const m of fresh) {
    if (!m.reactions?.length) m.reactions = prevReactions.get(m.id) ?? m.reactions
  }
  state.messages = fresh
  if (state.thread) refreshParent(state.thread, fresh)
  if (hasForeignNew && known.size > 0) beep()

  if (document.hidden) {
    // Viewing but tab hidden — count as unread until the user comes back.
    const count = countUnread(channelId, fresh)
    if (count) state.unread[channelId] = count
    refreshBadges()
  } else {
    markChannelRead(channelId)
  }
}

/**
 * Refresh a thread's replies in place. A thread closed mid-flight is no longer
 * rendered, so writing to it is harmless.
 */
async function loadReplies(thread: ChatThread) {
  const replies = await api.getReplies(state.workspaceId, thread.parent.id)
  replies.reverse() // oldest → newest, like the main pane
  // List responses omit reactions — carry over the lazily-fetched ones.
  const prevReactions = new Map(thread.replies.map((m) => [m.id, m.reactions] as const))
  for (const m of replies) {
    if (!m.reactions?.length) m.reactions = prevReactions.get(m.id) ?? m.reactions
  }
  thread.replies = replies
}

/** Point the thread at the freshly polled copy of its parent (edits, reply count). */
function refreshParent(thread: ChatThread, messages: ChatMessage[]) {
  const fresh = messages.find((m) => m.id === thread.parent.id)
  if (!fresh) return
  if (!fresh.reactions?.length) fresh.reactions = thread.parent.reactions
  thread.parent = fresh
}

async function pollThread() {
  if (state.thread) await loadReplies(state.thread)
}

/** First load of a just-opened thread: replies, then their reactions. */
async function loadThread(thread: ChatThread) {
  try {
    await loadReplies(thread)
  } finally {
    thread.loading = false
  }
  const recent = thread.replies.slice(-REACTION_REFRESH_COUNT)
  inBatches(recent, 4, (m) => refreshReactionsFor(m.id)).catch(() => {})
}

/** Refresh a single message's reactions wherever it is rendered. */
async function refreshReactionsFor(messageId: string) {
  const reactions = await api.getReactions(state.workspaceId, messageId)
  const threads = [state.thread, ...state.boxes.map((b) => b.thread)]
  const rendered = [
    ...state.messages,
    ...state.boxes.flatMap((b) => b.messages),
    ...threads.flatMap((t) => (t ? [t.parent, ...t.replies] : [])),
  ]
  for (const message of rendered) {
    if (message.id === messageId) message.reactions = reactions
  }
}

/** Refresh reactions for the newest messages in the open channel. */
async function refreshRecentReactions() {
  const recent = state.messages.slice(-REACTION_REFRESH_COUNT)
  await inBatches(recent, 4, (m) => refreshReactionsFor(m.id))
}

/** Actually deliver a queued message to ClickUp. */
async function dispatchPending(id: string) {
  const item = state.pending.find((p) => p.id === id)
  if (!item || item.dispatching) return
  item.dispatching = true
  item.failed = false
  try {
    if (item.threadParentId) {
      await api.sendReply(state.workspaceId, item.threadParentId, item.content)
    } else {
      await api.sendMessage(state.workspaceId, item.channelId, item.content)
    }
    state.pending = state.pending.filter((p) => p.id !== id)
    await Promise.all([pollMessages(), pollThread(), pollBox(item.channelId)])
  } catch (e) {
    item.dispatching = false
    item.failed = true // stays queued; Send now becomes Retry
    throw e
  }
}

function tickPending() {
  state.nowTick = Date.now()
  for (const item of state.pending) {
    if (!item.failed && !item.dispatching && item.sendAt <= state.nowTick) {
      dispatchPending(item.id).catch(() => {/* marked failed; user retries */})
    }
  }
}

function startPolling() {
  stopPolling()
  messageTimer = setInterval(() => {
    pollMessages().catch(() => {/* transient poll failure — next tick retries */})
    pollThread().catch(() => {})
    watchChannels().catch(() => {})
  }, MESSAGE_POLL_MS)
  channelTimer = setInterval(() => {
    // Channel list is kept fresh by watchChannels.
    sweepUnread().catch(() => {})
    refreshRecentReactions().catch(() => {})
  }, CHANNEL_POLL_MS)
  pinnedTimer = setInterval(() => {
    sweepPinned().catch(() => {})
  }, PINNED_POLL_MS)
  pendingTimer = setInterval(tickPending, 1_000)
}

function stopPolling() {
  if (messageTimer) clearInterval(messageTimer)
  if (channelTimer) clearInterval(channelTimer)
  if (pinnedTimer) clearInterval(pinnedTimer)
  if (pendingTimer) clearInterval(pendingTimer)
  messageTimer = channelTimer = pinnedTimer = pendingTimer = undefined
}

export function useChat() {
  const activeChannel = computed(
    () => state.channels.find((c) => c.id === state.activeChannelId) ?? null,
  )

  async function connect(token: string, workspaceId: string, workspaceName: string) {
    api.setToken(token)
    state.token = token
    state.workspaceId = workspaceId
    state.workspaceName = workspaceName
    saveSession()
    await loadRoster()
    dmNames = (await readCache<Record<string, string>>(dmNamesKey()))?.data ?? {}
    await loadChannels()
    connectedAt = Date.now()
    state.ready = true
    startPolling()
    sweepUnread().catch(() => {})
    // Channel selection is driven by the route (see ChatWindow).
  }

  /**
   * Connect on app start. Precedence: VITE_CLICKUP_API_KEY from .env, then the
   * session saved in localStorage. Returns false when manual setup is needed.
   */
  async function init(): Promise<boolean> {
    const envToken = import.meta.env.VITE_CLICKUP_API_KEY as string | undefined
    if (envToken?.trim()) {
      try {
        api.setToken(envToken)
        const envWorkspace = import.meta.env.VITE_CLICKUP_WORKSPACE_ID as
          | string
          | undefined
        const workspaces = await api.getWorkspaces()
        const ws = envWorkspace
          ? workspaces.find((w) => String(w.id) === envWorkspace.trim())
          : workspaces[0]
        if (ws) {
          await connect(envToken.trim(), String(ws.id), ws.name)
          return true
        }
      } catch {
        /* bad env key — fall through to saved session / setup modal */
      }
    }
    const session = loadSession()
    if (!session?.token || !session.workspaceId) return false
    try {
      await connect(session.token, session.workspaceId, session.workspaceName)
      return true
    } catch {
      return false
    }
  }

  function disconnect() {
    stopPolling()
    localStorage.removeItem(STORAGE_KEY)
    clearCache() // cached tasks + DM names belong to the signed-out user
    dmNames = {}
    state.ready = false
    state.token = ''
    state.workspaceId = ''
    state.channels = []
    state.messages = []
    state.activeChannelId = ''
    state.lastChannelId = ''
    state.me = null
    state.unread = {}
    state.pending = []
    state.boxes = []
    state.thread = null
    refreshBadges()
  }

  async function openChannel(channelId: string) {
    if (state.activeChannelId === channelId) return
    closeThread() // thread parent belongs to the channel being left
    state.activeChannelId = channelId
    state.lastChannelId = channelId
    // Freeze the divider position before reading marks move.
    state.dividerAt = lastRead[channelId] ?? 0
    state.messages = []
    state.loadingMessages = true
    try {
      await pollMessages()
    } finally {
      state.loadingMessages = false
    }
    refreshRecentReactions().catch(() => {})
  }

  /** Leaving the full chat page — nothing there is on screen any more. */
  function closeChannel() {
    closeThread()
    state.activeChannelId = ''
    state.messages = []
  }

  /**
   * Queue a message; it sends after the undo window elapses. Typed
   * `@Full Name` becomes ClickUp mention markup. `draft` is the raw composer
   * input, handed back on undo.
   */
  function send(content: string, draft?: string, channelId = state.activeChannelId) {
    const text = content.trim()
    if (!text || !channelId) return
    state.pending.push({
      id: crypto.randomUUID(),
      channelId,
      content: linkMentions(text, state.members.values()),
      draft: draft ?? content,
      sendAt: Date.now() + PENDING_DELAY_MS,
    })
  }

  /** Cancel a queued message. Returns it so the composer can restore the draft. */
  function undoSend(id: string): PendingSend | null {
    const item = state.pending.find((p) => p.id === id)
    if (!item || item.dispatching) return null
    state.pending = state.pending.filter((p) => p.id !== id)
    return item
  }

  /** Skip the rest of the undo window and deliver immediately. */
  async function sendNow(id: string) {
    await dispatchPending(id)
  }

  /** Add my reaction, or remove it if I already reacted with that emoji. */
  async function toggleReaction(message: ChatMessage, reaction: string) {
    const mine = (message.reactions ?? []).some(
      (r) => r.reaction === reaction && String(r.user_id) === state.me?.id,
    )
    if (mine) {
      await api.removeReaction(state.workspaceId, message.id, reaction)
    } else {
      await api.addReaction(state.workspaceId, message.id, reaction)
    }
    await refreshReactionsFor(message.id)
  }

  /** Open the chat page's reply thread panel for a message. */
  async function openThread(message: ChatMessage) {
    // Callers pass the readonly proxy from `state` — store the raw reactive
    // object (or a mutable copy) so reaction refreshes can write to it.
    state.thread = {
      parent: state.messages.find((m) => m.id === message.id) ?? { ...message },
      replies: [],
      loading: true,
    }
    await loadThread(state.thread) // read back: the reactive proxy, not the literal
  }

  function closeThread() {
    state.thread = null
  }

  /** Show a message's reply thread inside its docked box. */
  async function openBoxThread(channelId: string, message: ChatMessage) {
    const box = state.boxes.find((b) => b.channelId === channelId)
    if (!box) return
    box.thread = {
      parent: box.messages.find((m) => m.id === message.id) ?? { ...message },
      replies: [],
      loading: true,
    }
    await loadThread(box.thread)
  }

  /** Back from a box's thread to its conversation. */
  function closeBoxThread(channelId: string) {
    const box = state.boxes.find((b) => b.channelId === channelId)
    if (box) box.thread = null
  }

  /**
   * Queue a thread reply; same undo window and mention linking as main
   * messages. Defaults to the chat page's open thread.
   */
  function sendThreadReply(
    content: string,
    parentId = state.thread?.parent.id,
    channelId = state.activeChannelId,
  ) {
    const text = content.trim()
    if (!text || !parentId || !channelId) return
    state.pending.push({
      id: crypto.randomUUID(),
      channelId,
      threadParentId: parentId,
      content: linkMentions(text, state.members.values()),
      draft: content,
      sendAt: Date.now() + PENDING_DELAY_MS,
    })
  }

  /** Close a box; it won't auto-reopen until the channel has newer activity. */
  function closeBox(channelId: string) {
    const channel = state.channels.find((c) => c.id === channelId)
    dismissedAt[channelId] = channel?.latest_comment_at ?? Date.now()
    state.boxes = state.boxes.filter((b) => b.channelId !== channelId)
  }

  function toggleBox(channelId: string) {
    const box = state.boxes.find((b) => b.channelId === channelId)
    if (!box) return
    if (box.minimized) expandBox(box)
    else box.minimized = true
  }

  /** The page decides whether the dock shows (App, from the route). */
  function setDockActive(active: boolean) {
    if (state.dockActive === active) return
    state.dockActive = active
    if (!active) return
    // Boxes were off screen — catch them up.
    inBatches(state.boxes, 3, (b) => pollBox(b.channelId)).catch(() => {})
  }

  function togglePin(channelId: string) {
    state.pinned = state.pinned.includes(channelId)
      ? state.pinned.filter((id) => id !== channelId)
      : [...state.pinned, channelId]
    localStorage.setItem(PINNED_KEY, JSON.stringify(state.pinned))
  }

  function toggleSound() {
    state.soundOn = !state.soundOn
    localStorage.setItem(SOUND_KEY, state.soundOn ? '1' : '0')
  }

  function memberFor(userId?: string): Member {
    return (
      (userId && state.members.get(userId)) || {
        id: userId ?? '?',
        username: 'Unknown user',
        color: '#6c757d',
        profilePicture: null,
        initials: '?',
      }
    )
  }

  return {
    state: readonly(state),
    activeChannel,
    connect,
    init,
    disconnect,
    openChannel,
    closeChannel,
    openBox,
    closeBox,
    toggleBox,
    setDockActive,
    send,
    undoSend,
    sendNow,
    memberFor,
    toggleSound,
    togglePin,
    toggleReaction,
    openThread,
    closeThread,
    openBoxThread,
    closeBoxThread,
    sendThreadReply,
  }
}

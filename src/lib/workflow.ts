// Agile rules for the dashboard. Every rule here is explicit and visible in
// the UI ("why is this in Focus?"), so the ranking is never a black box.

import type { Stage, TaskRow } from '../types'

export interface StageInfo {
  key: Stage
  label: string
  icon: string
  /** Status names (lowercase) that land in this stage. */
  statuses: string[]
}

/**
 * Board columns, left → right, following the team's ticket flow:
 *   New → Triage → Planning → Icebox → Backlog → Doing / In progress → Review
 *   → Approved → Closed, or Review → Rejected → back to Backlog (rework).
 * `hold`, `comms` and `discovery` aren't in the flow; they're placed where
 * they behave (Blocked, Review, Planning). Edit `statuses` to adjust.
 */
export const STAGES: StageInfo[] = [
  { key: 'inbox', label: 'Inbox', icon: 'inbox', statuses: ['new', 'triage'] },
  { key: 'planning', label: 'Planning', icon: 'compass', statuses: ['planning', 'discovery'] },
  { key: 'icebox', label: 'Icebox', icon: 'snow', statuses: ['icebox'] },
  // Rejected = returned from review for rework; it re-enters the backlog.
  { key: 'backlog', label: 'Backlog', icon: 'archive', statuses: ['backlog', 'rejected'] },
  { key: 'doing', label: 'Doing', icon: 'play-circle', statuses: ['doing', 'in progress'] },
  { key: 'review', label: 'Review', icon: 'eye', statuses: ['review', 'comms'] },
  { key: 'blocked', label: 'Blocked', icon: 'pause-circle', statuses: ['hold'] },
  // Approved = passed review, waiting to be closed — nothing left to do.
  { key: 'approved', label: 'Approved', icon: 'check2-circle', statuses: ['approved'] },
  { key: 'done', label: 'Closed', icon: 'check-circle-fill', statuses: ['closed', 'complete'] },
]

const STAGE_BY_STATUS = new Map(
  STAGES.flatMap((s) => s.statuses.map((status) => [status, s.key] as const)),
)

/** Status → stage. The explicit map wins (e.g. "rejected" has ClickUp type
 *  `done` in some spaces but is rework here); unmapped statuses fall back to
 *  ClickUp's own status type. */
export function stageOf(status: string, statusType: string): Stage {
  const mapped = STAGE_BY_STATUS.get(status.toLowerCase())
  if (mapped) return mapped
  if (statusType === 'done' || statusType === 'closed') return 'done'
  if (statusType === 'open') return 'inbox'
  if (statusType === 'unstarted') return 'backlog'
  return 'doing'
}

// ---------- Time ----------

export const DAY_MS = 24 * 60 * 60 * 1000

export function startOfToday(now = Date.now()): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** "2h 30m" from a duration in ms; "—" when unset. */
export function formatDuration(ms: number | null | undefined): string {
  if (!ms) return '—'
  const totalMin = Math.round(ms / 60_000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return [h && `${h}h`, m && `${m}m`].filter(Boolean).join(' ') || '0m'
}

/** Whole days from today's midnight to `ms` (negative = in the past). */
export function daysFromToday(ms: number, now = Date.now()): number {
  return Math.floor((ms - startOfToday(now)) / DAY_MS)
}

/** Still needs work from me: not approved and not closed. */
export const isOpen = (row: TaskRow) => row.stage !== 'done' && row.stage !== 'approved'
export const isOverdue = (row: TaskRow, now = Date.now()) =>
  isOpen(row) && row.due !== null && row.due < startOfToday(now)

// ---------- Sprints ----------

export interface Sprint {
  name: string
  start: number
  /** Last day of the sprint, inclusive (midnight). */
  end: number
}

// "Sprint 21 (9/28 - 10/11)"
const SPRINT_RE = /\((\d{1,2})\/(\d{1,2})\s*-\s*(\d{1,2})\/(\d{1,2})\)/

/** The sprint list (by name) whose date range contains today, if any. */
export function currentSprint(rows: readonly TaskRow[], now = Date.now()): Sprint | null {
  const today = startOfToday(now)
  const year = new Date(now).getFullYear()
  const names = new Set(rows.flatMap((r) => r.lists).filter((n) => /sprint/i.test(n)))
  for (const name of names) {
    const m = SPRINT_RE.exec(name)
    if (!m) continue
    const [sm, sd, em, ed] = m.slice(1).map(Number) as [number, number, number, number]
    // Sprints are two weeks — try this year and its neighbours so a
    // Dec→Jan sprint resolves on either side of New Year.
    for (const y of [year - 1, year, year + 1]) {
      const start = new Date(y, sm - 1, sd).getTime()
      const end = new Date(em < sm ? y + 1 : y, em - 1, ed).getTime()
      if (start <= today && today <= end) return { name, start, end }
    }
  }
  return null
}

// ---------- Focus ranking ----------

export interface FocusReason {
  key: 'overdue' | 'dueSoon' | 'urgent' | 'sprint' | 'doing' | 'rework'
  label: string
  variant: 'danger' | 'warning' | 'primary' | 'info' | 'success'
  icon: string
}

/** How far ahead "due soon" looks. */
export const DUE_SOON_DAYS = 7

/** Focus only considers tasks in these statuses (lowercase)… */
export const FOCUS_STATUSES = ['backlog', 'doing', 'rejected']
/** …whose home list is one of these. */
export const FOCUS_LISTS = ['CMS', 'CRM', 'Ranch and Farm', 'Whitetail', 'WhitetailOS']

/**
 * Tasks in FOCUS_STATUSES on FOCUS_LISTS matching at least one rule, ranked
 * lexicographically by the FIRST rule they match (rules are in priority order):
 *   1. overdue  2. due within 7 days  3. urgent  4. in the current sprint
 *   5. already in progress (finish before starting new work)
 *   6. rework (rejected in review, back in the backlog)
 * Ties: priority, then due date (soonest), then most recently updated.
 */
export function focusList(rows: readonly TaskRow[], sprint: Sprint | null, now = Date.now()) {
  const ranked = []
  for (const row of rows) {
    if (!FOCUS_STATUSES.includes(row.status.toLowerCase()) || !FOCUS_LISTS.includes(row.list)) continue
    const reasons: FocusReason[] = []
    if (isOverdue(row, now)) {
      const days = -daysFromToday(row.due!, now)
      reasons.push({ key: 'overdue', label: `${days}d overdue`, variant: 'danger', icon: 'exclamation-octagon' })
    } else if (row.due !== null && daysFromToday(row.due, now) <= DUE_SOON_DAYS) {
      const days = daysFromToday(row.due, now)
      const label = days === 0 ? 'due today' : days === 1 ? 'due tomorrow' : `due in ${days}d`
      reasons.push({ key: 'dueSoon', label, variant: 'warning', icon: 'clock' })
    }
    if (row.priority === 'urgent') {
      reasons.push({ key: 'urgent', label: 'urgent', variant: 'danger', icon: 'fire' })
    }
    if (sprint && row.lists.includes(sprint.name)) {
      reasons.push({ key: 'sprint', label: 'in sprint', variant: 'primary', icon: 'flag' })
    }
    if (row.stage === 'doing') {
      reasons.push({ key: 'doing', label: 'in progress', variant: 'success', icon: 'play-circle' })
    }
    if (row.status.toLowerCase() === 'rejected') {
      reasons.push({ key: 'rework', label: 'rework — rejected in review', variant: 'warning', icon: 'arrow-counterclockwise' })
    }
    if (reasons.length) ranked.push({ row, reasons, bucket: RULE_ORDER.indexOf(reasons[0]!.key) })
  }
  return ranked.sort(
    (a, b) =>
      a.bucket - b.bucket ||
      a.row.priorityRank - b.row.priorityRank ||
      (a.row.due ?? Infinity) - (b.row.due ?? Infinity) ||
      b.row.updated - a.row.updated,
  )
}

const RULE_ORDER: FocusReason['key'][] = ['overdue', 'dueSoon', 'urgent', 'sprint', 'doing', 'rework']

/** Open tasks untouched this long are "going stale". */
export const STALE_DAYS = 30

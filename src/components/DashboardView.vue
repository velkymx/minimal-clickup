<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  VibeAlert,
  VibeBadge,
  VibeButton,
  VibeCard,
  VibeCol,
  VibeIcon,
  VibeLink,
  VibeListGroup,
  VibeProgress,
  VibeRow,
  VibeSpinner,
  type ListGroupItem,
} from '@velkymx/vibeui'
import { useMyTasks } from '../composables/useMyTasks'
import { ageLabel } from '../lib/taskCache'
import {
  DAY_MS,
  DUE_SOON_DAYS,
  FOCUS_LISTS,
  FOCUS_STATUSES,
  STAGES,
  STALE_DAYS,
  currentSprint,
  daysFromToday,
  focusList,
  isOpen,
  isOverdue,
  startOfToday,
} from '../lib/workflow'
import type { Stage, TaskRow } from '../types'

const { tasks, ensureLoaded, refreshFromClickUp } = useMyTasks()
onMounted(ensureLoaded)

// Ticks relative labels ("Cached 4m ago", "due in 2d").
const now = ref(Date.now())
const clock = setInterval(() => (now.value = Date.now()), 30_000)
onUnmounted(() => clearInterval(clock))

const rows = computed(() => tasks.rows as TaskRow[])
const open = computed(() => rows.value.filter(isOpen))
const byStage = (stage: Stage) => rows.value.filter((r) => r.stage === stage)

/** Table link pre-filtered to the given statuses (and optional priority). */
function tableLink(statuses: readonly string[], priority?: string): string {
  const query = new URLSearchParams()
  query.set('status', [...new Set(statuses)].join(','))
  if (priority) query.set('priority', priority)
  return `/tasks?${query}`
}
const statusesOf = (list: readonly TaskRow[]) => list.map((r) => r.status)

// ---------- KPI tiles ----------

interface Tile {
  label: string
  value: number
  icon: string
  /** Icon color — tiles name their state in text, color is secondary. */
  tone: string
  hint: string
  to?: string
}

const tiles = computed<Tile[]>(() => {
  const today = startOfToday(now.value)
  const overdue = open.value.filter((r) => isOverdue(r, now.value))
  const dueSoon = open.value.filter(
    (r) => r.due !== null && r.due >= today && daysFromToday(r.due, now.value) <= DUE_SOON_DAYS,
  )
  const urgent = open.value.filter((r) => r.priority === 'urgent')
  const review = byStage('review')
  const blocked = byStage('blocked')
  return [
    { label: 'Open', value: open.value.length, icon: 'list-task', tone: 'text-body-secondary', hint: 'not done', to: tableLink(statusesOf(open.value)) },
    { label: 'Overdue', value: overdue.length, icon: 'exclamation-octagon', tone: 'text-danger', hint: 'due date passed' },
    { label: 'Due soon', value: dueSoon.length, icon: 'clock', tone: 'text-warning', hint: `next ${DUE_SOON_DAYS} days` },
    { label: 'Urgent', value: urgent.length, icon: 'fire', tone: 'text-danger', hint: 'open, urgent priority', to: tableLink(statusesOf(urgent), 'urgent') },
    { label: 'In review', value: review.length, icon: 'eye', tone: 'text-info', hint: 'waiting on review', to: tableLink(statusesOf(review)) },
    { label: 'Blocked', value: blocked.length, icon: 'pause-circle', tone: 'text-body-secondary', hint: 'on hold', to: tableLink(statusesOf(blocked)) },
  ]
})

// ---------- Focus ----------

const FOCUS_LIMIT = 12
const sprint = computed(() => currentSprint(rows.value, now.value))
const focus = computed(() => focusList(rows.value, sprint.value, now.value))
const focusTop = computed(() => focus.value.slice(0, FOCUS_LIMIT))
const focusItems = computed<ListGroupItem[]>(() =>
  focusTop.value.map(({ row }) => ({ text: row.name, to: `/tasks/${row.id}` })),
)

// ---------- Sprint ----------

/** Sprint progress counts work handed off: in review, approved or closed. */
const SPRINT_DONE: Stage[] = ['review', 'approved', 'done']

const sprintInfo = computed(() => {
  const s = sprint.value
  if (!s) return null
  // Open list + recently completed (closed tasks only come from the latter).
  const byId = new Map([...(tasks.completed as TaskRow[]), ...rows.value].map((r) => [r.id, r]))
  const mine = [...byId.values()].filter((r) => r.lists.includes(s.name))
  const done = mine.filter((r) => SPRINT_DONE.includes(r.stage)).length
  const totalDays = Math.round((s.end - s.start) / DAY_MS) + 1
  const dayNumber = Math.round((startOfToday(now.value) - s.start) / DAY_MS) + 1
  const dateFmt = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return {
    name: s.name,
    range: `${dateFmt(s.start)} – ${dateFmt(s.end)}`,
    dayNumber,
    totalDays,
    daysLeft: totalDays - dayNumber,
    mine,
    done,
    /** Listed in the box: still to do (review/approved/closed only count). */
    remaining: mine
      .filter((r) => !SPRINT_DONE.includes(r.stage))
      .sort((a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] || a.priorityRank - b.priorityRank),
  }
})

const STAGE_ORDER = Object.fromEntries(STAGES.map((s, i) => [s.key, i])) as Record<Stage, number>
const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.key, s.label])) as Record<Stage, string>

const sprintItems = computed<ListGroupItem[]>(() =>
  (sprintInfo.value?.remaining ?? []).map((r) => ({ text: r.name, to: `/tasks/${r.id}` })),
)

// ---------- Flow health ----------

const daysSince = (ms: number) => Math.floor((now.value - ms) / DAY_MS)

/** Review items, longest-waiting first — review is where flow stalls. */
const reviewQueue = computed(() =>
  byStage('review').sort((a, b) => a.updated - b.updated).slice(0, 8),
)

const stale = computed(() =>
  open.value
    .filter((r) => r.stage !== 'review' && daysSince(r.updated) >= STALE_DAYS)
    .sort((a, b) => a.updated - b.updated),
)

const listItems = (list: readonly TaskRow[]): ListGroupItem[] =>
  list.map((r) => ({ text: r.name, to: `/tasks/${r.id}` }))
</script>

<template>
  <main class="chat-main dashboard">
    <header class="chat-header gap-2">
      <VibeIcon icon="speedometer2" />
      <h1 class="h5 mb-0 flex-grow-1">Dashboard</h1>
      <span v-if="tasks.fetchedAt" class="small text-body-secondary text-nowrap">
        Cached {{ ageLabel(tasks.fetchedAt, now) }}
      </span>
      <VibeButton
        variant="secondary"
        outline
        size="sm"
        class="text-nowrap"
        :disabled="tasks.loading"
        @click="refreshFromClickUp()"
      >
        <VibeSpinner v-if="tasks.loading" size="sm" class="me-1" />
        <VibeIcon v-else icon="arrow-clockwise" class="me-1" />Refresh ClickUp
      </VibeButton>
    </header>

    <div class="tasks-body">
      <VibeAlert v-if="tasks.error" variant="danger" :message="`Couldn't load tasks: ${tasks.error}`" />

      <div v-if="!tasks.loaded" class="p-5 text-center">
        <VibeSpinner variant="primary" />
      </div>

      <template v-else>
        <!-- KPI row -->
        <div class="kpi-row mb-3">
          <VibeCard v-for="tile in tiles" :key="tile.label" class="kpi-tile">
            <div class="d-flex align-items-center gap-2 small fw-semibold">
              <VibeIcon :icon="tile.icon" :class="tile.tone" />{{ tile.label }}
            </div>
            <div class="kpi-value">{{ tile.value }}</div>
            <div class="small text-body-secondary d-flex justify-content-between gap-2">
              <span>{{ tile.hint }}</span>
              <VibeLink v-if="tile.to && tile.value" :to="tile.to" :underline="false">View</VibeLink>
            </div>
          </VibeCard>
        </div>

        <VibeRow class="g-3 mb-3">
          <!-- Focus now -->
          <VibeCol :cols="12" :xl="8">
            <VibeCard body-class="p-0" class="h-100">
              <template #header>
                <VibeIcon icon="bullseye" class="me-1" />Focus now
                <span class="small text-body-secondary ms-1">
                  {{ focusTop.length }} of {{ focus.length }} that need attention
                </span>
              </template>
              <p v-if="!focusTop.length" class="text-body-secondary p-3 mb-0">
                Nothing in these statuses and lists is overdue, due soon, urgent, in the sprint, or in progress.
              </p>
              <VibeListGroup v-else flush :items="focusItems">
                <template #item="{ index }">
                  <template v-for="f in [focusTop[index]]" :key="f?.row.id">
                    <div v-if="f" class="focus-item">
                      <span class="focus-rank text-body-secondary">{{ index + 1 }}</span>
                      <div class="flex-grow-1 min-w-0">
                        <div class="text-truncate">
                          <span class="small text-body-secondary me-2">{{ f.row.taskId }}</span>{{ f.row.name }}
                        </div>
                        <div class="d-flex flex-wrap gap-1 mt-1">
                          <VibeBadge
                            v-for="reason in f.reasons"
                            :key="reason.key"
                            :variant="reason.variant"
                            subtle
                          >
                            <VibeIcon :icon="reason.icon" class="me-1" />{{ reason.label }}
                          </VibeBadge>
                          <VibeBadge
                            class="status-badge"
                            text-color="white"
                            :style="{ '--status-color': f.row.statusColor }"
                          >
                            {{ f.row.status }}
                          </VibeBadge>
                        </div>
                      </div>
                    </div>
                  </template>
                </template>
              </VibeListGroup>
              <template #footer>
                <span class="small text-body-secondary">
                  Statuses {{ FOCUS_STATUSES.join(', ') }} on lists {{ FOCUS_LISTS.join(', ') }}.
                  Ranked by first match: overdue → due within {{ DUE_SOON_DAYS }} days → urgent →
                  in current sprint → in progress → rework (rejected); then priority, due date.
                </span>
              </template>
            </VibeCard>
          </VibeCol>

          <!-- Sprint -->
          <VibeCol :cols="12" :xl="4">
            <VibeCard body-class="p-0" class="h-100">
              <template #header>
                <VibeIcon icon="flag" class="me-1" />{{ sprintInfo?.name ?? 'Sprint' }}
              </template>
              <p v-if="!sprintInfo" class="text-body-secondary p-3 mb-0">
                No sprint list whose dates include today.
              </p>
              <template v-else>
                <div class="p-3">
                  <div class="d-flex justify-content-between small mb-1">
                    <span>{{ sprintInfo.range }}</span>
                    <span>
                      Day {{ sprintInfo.dayNumber }} of {{ sprintInfo.totalDays }} ·
                      <strong>{{ sprintInfo.daysLeft }} days left</strong>
                    </span>
                  </div>
                  <VibeProgress
                    height="8px"
                    :bars="[{ value: sprintInfo.dayNumber, max: sprintInfo.totalDays, variant: 'secondary' }]"
                    :aria-label="`Sprint time elapsed: day ${sprintInfo.dayNumber} of ${sprintInfo.totalDays}`"
                  />
                  <div class="d-flex justify-content-between small mt-3 mb-1">
                    <span>My sprint tasks done</span>
                    <strong>{{ sprintInfo.done }} of {{ sprintInfo.mine.length }}</strong>
                  </div>
                  <VibeProgress
                    height="8px"
                    :bars="[{ value: sprintInfo.done, max: Math.max(sprintInfo.mine.length, 1), variant: 'success' }]"
                    :aria-label="`Sprint tasks done: ${sprintInfo.done} of ${sprintInfo.mine.length}`"
                  />
                </div>
                <VibeListGroup flush :items="sprintItems">
                  <template #item="{ item, index }">
                    <div class="d-flex align-items-center gap-2">
                      <span class="flex-grow-1 text-truncate">{{ item.text }}</span>
                      <VibeBadge variant="secondary" subtle>
                        {{ STAGE_LABEL[sprintInfo.remaining[index]?.stage ?? 'backlog'] }}
                      </VibeBadge>
                    </div>
                  </template>
                </VibeListGroup>
              </template>
            </VibeCard>
          </VibeCol>
        </VibeRow>

        <VibeRow class="g-3">
          <!-- Review queue -->
          <VibeCol :cols="12" :lg="6">
            <VibeCard body-class="p-0" class="h-100">
              <template #header>
                <VibeIcon icon="eye" class="me-1" />Review queue
                <span class="small text-body-secondary ms-1">longest waiting first</span>
              </template>
              <p v-if="!reviewQueue.length" class="text-body-secondary p-3 mb-0">Nothing in review.</p>
              <VibeListGroup v-else flush :items="listItems(reviewQueue)">
                <template #item="{ item, index }">
                  <div class="d-flex align-items-center gap-2">
                    <span class="flex-grow-1 text-truncate">{{ item.text }}</span>
                    <span class="small text-body-secondary text-nowrap">
                      {{ daysSince(reviewQueue[index]?.updated ?? now) }}d untouched
                    </span>
                  </div>
                </template>
              </VibeListGroup>
            </VibeCard>
          </VibeCol>

          <!-- Going stale -->
          <VibeCol :cols="12" :lg="6">
            <VibeCard body-class="p-0" class="h-100">
              <template #header>
                <VibeIcon icon="hourglass-bottom" class="me-1" />Going stale
                <span class="small text-body-secondary ms-1">
                  {{ stale.length }} open, no update in {{ STALE_DAYS }}+ days
                </span>
              </template>
              <p v-if="!stale.length" class="text-body-secondary p-3 mb-0">Nothing stale.</p>
              <VibeListGroup v-else flush :items="listItems(stale.slice(0, 8))">
                <template #item="{ item, index }">
                  <div class="d-flex align-items-center gap-2">
                    <span class="flex-grow-1 text-truncate">{{ item.text }}</span>
                    <VibeBadge variant="secondary" subtle>{{ STAGE_LABEL[stale[index]?.stage ?? 'backlog'] }}</VibeBadge>
                    <span class="small text-body-secondary text-nowrap">
                      {{ daysSince(stale[index]?.updated ?? now) }}d
                    </span>
                  </div>
                </template>
              </VibeListGroup>
            </VibeCard>
          </VibeCol>
        </VibeRow>
      </template>
    </div>
  </main>
</template>

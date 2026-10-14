<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import {
  VibeAlert,
  VibeBadge,
  VibeButton,
  VibeCard,
  VibeCol,
  VibeIcon,
  VibeListGroup,
  VibeProgress,
  VibeRow,
  VibeSpinner,
  type ListGroupItem,
  type Variant,
} from '@velkymx/vibeui'
import { useRoute } from 'vue-router'
import { getCommentReplies, getTask, getTaskComments } from '../lib/clickup'
import { markdownToSafeHtml } from '../lib/markdown'
import { ageLabel, readCache, taskCacheKey, writeCache } from '../lib/taskCache'
import { formatDuration } from '../lib/workflow'
import type {
  ClickUpTaskDetail,
  TaskComment,
  TaskCustomField,
  TaskUser,
} from '../types'

const PRIORITY_VARIANT: Record<string, Variant> = {
  urgent: 'danger',
  high: 'warning',
  normal: 'primary',
  low: 'secondary',
}

const route = useRoute()

const task = ref<ClickUpTaskDetail | null>(null)
const comments = ref<TaskComment[]>([])
/** Name + status of tasks referenced by id only (parent, dependencies, links). */
type RelatedMap = Record<string, { name: string; status: string; color: string }>
const related = ref<RelatedMap>({})
const loading = ref(false)
const error = ref('')
/** When the shown data was last fetched from ClickUp (0 = never). */
const fetchedAt = ref(0)

/** Everything the view shows for one task — cached as a single entry. */
interface TaskBundle {
  task: ClickUpTaskDetail
  comments: TaskComment[]
  related: RelatedMap
}

// Ticks the "Cached Xm ago" label.
const now = ref(Date.now())
const clock = setInterval(() => (now.value = Date.now()), 30_000)
onUnmounted(() => clearInterval(clock))

/** A few at a time — ClickUp rate-limits at 100 req/min per token. */
async function inBatches<T>(items: readonly T[], size: number, fn: (item: T) => Promise<unknown>) {
  for (let i = 0; i < items.length; i += size) {
    await Promise.allSettled(items.slice(i, i + size).map(fn))
  }
}

function apply(bundle: TaskBundle, savedAt: number) {
  task.value = bundle.task
  comments.value = bundle.comments
  related.value = bundle.related
  fetchedAt.value = savedAt
}

/** Render from cache; only hit ClickUp when this task isn't cached yet. */
async function open(taskId: string) {
  error.value = ''
  const cached = await readCache<TaskBundle>(taskCacheKey(taskId))
  if (route.params.taskId !== taskId) return // navigated away mid-read
  if (cached) {
    apply(cached.data, cached.savedAt)
    return
  }
  task.value = null
  comments.value = []
  related.value = {}
  fetchedAt.value = 0
  await refreshFromClickUp(taskId)
}

/** Pull task, comments and related-task names from ClickUp; replace the cache. */
async function refreshFromClickUp(taskId: string) {
  loading.value = true
  error.value = ''
  try {
    const fresh = await getTask(taskId)
    const [freshComments, freshRelated] = await Promise.all([
      fetchComments(taskId),
      fetchRelated(fresh),
    ])
    const bundle: TaskBundle = { task: fresh, comments: freshComments, related: freshRelated }
    await writeCache(taskCacheKey(taskId), bundle)
    if (route.params.taskId === taskId) apply(bundle, Date.now())
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

async function fetchComments(taskId: string): Promise<TaskComment[]> {
  const top = await getTaskComments(taskId)
  await inBatches(top.filter((c) => c.reply_count > 0), 4, async (c) => {
    const replies = await getCommentReplies(c.id)
    c.replies = replies.sort((a, b) => Number(a.date) - Number(b.date))
  })
  return top
}

async function fetchRelated(t: ClickUpTaskDetail): Promise<RelatedMap> {
  const deps = t.dependencies.flatMap((d) => [d.task_id, d.depends_on])
  const links = t.linked_tasks.flatMap((l) => [l.task_id, l.link_id])
  const ids = new Set([...(t.parent ? [t.parent] : []), ...deps, ...links])
  ids.delete(t.id)
  const out: RelatedMap = {}
  await inBatches([...ids], 4, async (id) => {
    const other = await getTask(id)
    out[id] = { name: other.name, status: other.status.status, color: other.status.color }
  })
  return out
}

watch(
  () => route.params.taskId,
  (id) => {
    if (typeof id === 'string' && id) open(id)
  },
  { immediate: true },
)

// ---------- Derived ----------

const descriptionHtml = computed(() => {
  const md = task.value?.markdown_description || task.value?.text_content || ''
  return md.trim() ? markdownToSafeHtml(md) : ''
})

const waitingOn = computed(() =>
  (task.value?.dependencies ?? [])
    .filter((d) => d.task_id === task.value?.id)
    .map((d) => d.depends_on),
)
const blocking = computed(() =>
  (task.value?.dependencies ?? [])
    .filter((d) => d.depends_on === task.value?.id)
    .map((d) => d.task_id),
)
const linked = computed(() =>
  (task.value?.linked_tasks ?? []).map((l) =>
    l.task_id === task.value?.id ? l.link_id : l.task_id,
  ),
)

interface RelatedGroup {
  title: string
  icon: string
  ids: string[]
}
const relatedGroups = computed<RelatedGroup[]>(() =>
  [
    { title: 'Parent', icon: 'arrow-up-square', ids: task.value?.parent ? [task.value.parent] : [] },
    { title: 'Waiting on', icon: 'hourglass-split', ids: waitingOn.value },
    { title: 'Blocking', icon: 'sign-stop', ids: blocking.value },
    { title: 'Linked', icon: 'link-45deg', ids: linked.value },
  ].filter((g) => g.ids.length),
)

function relatedItems(ids: string[]): ListGroupItem[] {
  return ids.map((id) => ({ text: related.value[id]?.name ?? id, to: `/tasks/${id}` }))
}

const subtaskItems = computed<ListGroupItem[]>(() =>
  (task.value?.subtasks ?? []).map((s) => ({ text: s.name, to: `/tasks/${s.id}` })),
)

const filledFields = computed(() =>
  (task.value?.custom_fields ?? [])
    .map((f) => ({ field: f, display: fieldDisplay(f) }))
    .filter((f) => f.display !== null)
    .sort((a, b) => a.field.name.localeCompare(b.field.name)),
)
const emptyFieldCount = computed(
  () => (task.value?.custom_fields.length ?? 0) - filledFields.value.length,
)

const isOverdue = computed(() => {
  const t = task.value
  return !!t?.due_date && !t.date_closed && Number(t.due_date) < Date.now()
})

const timeProgress = computed(() => {
  const t = task.value
  if (!t?.time_estimate) return null
  const pct = Math.round(((t.time_spent ?? 0) / t.time_estimate) * 100)
  return { value: Math.min(pct, 100), variant: (pct > 100 ? 'danger' : 'success') as Variant, pct }
})

const commentItems = computed<ListGroupItem[]>(() =>
  comments.value.map((c) => ({ text: c.comment_text })),
)

// ---------- Formatting ----------

function formatDate(ms: string | number | null | undefined, withTime = false): string {
  if (!ms) return '—'
  const d = new Date(Number(ms))
  return withTime ? d.toLocaleString() : d.toLocaleDateString()
}

function formatSize(bytes?: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

/** Human value of a custom field, or null when it's unset. */
function fieldDisplay(f: TaskCustomField): string | null {
  const v = f.value
  if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return null
  const options = f.type_config?.options ?? []
  switch (f.type) {
    case 'drop_down':
      // Value is the option's orderindex (older fields: its id).
      return options.find((o) => o.orderindex === Number(v) || o.id === v)?.name ?? String(v)
    case 'labels':
      return (v as string[])
        .map((id) => {
          const o = options.find((opt) => opt.id === id)
          return o?.label ?? o?.name ?? id
        })
        .join(', ')
    case 'users':
      return (v as TaskUser[]).map((u) => u.username).join(', ')
    case 'tasks':
      return (v as Array<{ id: string; name?: string }>).map((t) => t.name ?? t.id).join(', ')
    case 'date':
      return formatDate(v as string)
    case 'checkbox':
      return v === true || v === 'true' ? 'Yes' : 'No'
    case 'automatic_progress':
    case 'manual_progress':
      return `${(v as { percent_complete?: number }).percent_complete ?? 0}%`
    case 'location':
      return (v as { formatted_address?: string }).formatted_address ?? null
    default:
      return typeof v === 'object' ? JSON.stringify(v) : String(v)
  }
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}
</script>

<template>
  <main class="chat-main task-detail">
    <header class="chat-header gap-2">
      <VibeButton variant="secondary" outline size="sm" to="/tasks" title="Back to my tasks">
        <VibeIcon icon="arrow-left" />
      </VibeButton>
      <VibeBadge v-if="task?.custom_id" variant="secondary">{{ task.custom_id }}</VibeBadge>
      <h1 class="h5 mb-0 flex-grow-1 text-truncate">{{ task?.name ?? 'Task' }}</h1>
      <span v-if="fetchedAt" class="small text-body-secondary text-nowrap">
        Cached {{ ageLabel(fetchedAt, now) }}
      </span>
      <VibeButton
        variant="secondary"
        outline
        size="sm"
        class="text-nowrap"
        :disabled="loading"
        @click="refreshFromClickUp(String(route.params.taskId))"
      >
        <VibeSpinner v-if="loading" size="sm" class="me-1" />
        <VibeIcon v-else icon="arrow-clockwise" class="me-1" />Refresh ClickUp
      </VibeButton>
      <VibeButton
        v-if="task"
        variant="primary"
        size="sm"
        :href="task.url"
        target="_blank"
        rel="noopener"
      >
        <VibeIcon icon="box-arrow-up-right" class="me-1" />Open in ClickUp
      </VibeButton>
    </header>

    <div class="tasks-body">
      <VibeAlert v-if="error" variant="danger" :message="error" />

      <div v-if="loading && !task" class="p-5 text-center">
        <VibeSpinner variant="primary" />
      </div>

      <VibeRow v-else-if="task" class="g-3">
        <!-- ---------- Main column ---------- -->
        <VibeCol :cols="12" :lg="8" class="d-flex flex-column gap-3">
          <VibeCard header="Description">
            <div v-if="descriptionHtml" class="task-description" v-html="descriptionHtml"></div>
            <p v-else class="text-body-secondary mb-0">No description.</p>
          </VibeCard>

          <VibeCard
            v-for="checklist in task.checklists"
            :key="checklist.id"
            :header="`${checklist.name} (${checklist.items.filter((i) => i.resolved).length}/${checklist.items.length})`"
            body-class="p-0"
          >
            <VibeListGroup flush :items="checklist.items.map((i) => ({ text: i.name }))">
              <template #item="{ item, index }">
                <span :class="{ 'text-decoration-line-through text-body-secondary': checklist.items[index]?.resolved }">
                  <VibeIcon
                    :icon="checklist.items[index]?.resolved ? 'check-square-fill' : 'square'"
                    :class="checklist.items[index]?.resolved ? 'text-success me-2' : 'me-2'"
                  />
                  {{ item.text }}
                </span>
                <span v-if="checklist.items[index]?.assignee" class="small text-body-secondary ms-2">
                  — {{ checklist.items[index]?.assignee?.username }}
                </span>
              </template>
            </VibeListGroup>
          </VibeCard>

          <VibeCard v-if="subtaskItems.length" :header="`Subtasks (${subtaskItems.length})`" body-class="p-0">
            <VibeListGroup flush :items="subtaskItems">
              <template #item="{ item, index }">
                <VibeBadge
                  class="status-badge me-2"
                  text-color="white"
                  :style="{ '--status-color': task.subtasks?.[index]?.status.color }"
                >
                  {{ task.subtasks?.[index]?.status.status }}
                </VibeBadge>
                {{ item.text }}
              </template>
            </VibeListGroup>
          </VibeCard>

          <VibeCard v-if="task.attachments.length" :header="`Attachments (${task.attachments.length})`" body-class="p-0">
            <VibeListGroup
              flush
              :items="task.attachments.map((a) => ({ text: a.title, href: a.url }))"
            >
              <template #item="{ item, index }">
                <VibeIcon icon="paperclip" class="me-1" />
                {{ item.text }}
                <span class="small text-body-secondary ms-2">
                  {{ formatSize(task.attachments[index]?.size) }}
                  · {{ task.attachments[index]?.user?.username }}
                  · {{ formatDate(task.attachments[index]?.date) }}
                </span>
              </template>
            </VibeListGroup>
          </VibeCard>

          <VibeCard :header="`Comments (${comments.length})`" body-class="p-0">
            <p v-if="!comments.length" class="text-body-secondary p-3 mb-0">No comments.</p>
            <VibeListGroup v-else flush :items="commentItems">
              <template #item="{ index }">
                <template v-for="c in [comments[index]]" :key="c?.id">
                  <div v-if="c" class="task-comment">
                    <div class="d-flex align-items-center gap-2 mb-1">
                      <img v-if="c.user.profilePicture" class="avatar avatar-sm" :src="c.user.profilePicture" :alt="c.user.username" />
                      <div v-else class="avatar avatar-sm avatar-initials" :style="{ backgroundColor: c.user.color ?? '#6c757d' }">
                        {{ c.user.initials }}
                      </div>
                      <strong>{{ c.user.username }}</strong>
                      <span class="small text-body-secondary">{{ formatDate(c.date, true) }}</span>
                      <VibeBadge v-if="c.resolved" variant="success" subtle>resolved</VibeBadge>
                    </div>
                    <div class="comment-text">{{ c.comment_text.trim() }}</div>

                    <div v-if="c.replies?.length" class="comment-replies">
                      <div v-for="r in c.replies" :key="r.id" class="mt-2">
                        <div class="d-flex align-items-center gap-2 mb-1">
                          <strong class="small">{{ r.user.username }}</strong>
                          <span class="small text-body-secondary">{{ formatDate(r.date, true) }}</span>
                        </div>
                        <div class="comment-text small">{{ r.comment_text.trim() }}</div>
                      </div>
                    </div>
                  </div>
                </template>
              </template>
            </VibeListGroup>
          </VibeCard>
        </VibeCol>

        <!-- ---------- Side column ---------- -->
        <VibeCol :cols="12" :lg="4" class="d-flex flex-column gap-3">
          <VibeCard header="Details">
            <dl class="task-props mb-0">
              <dt>Status</dt>
              <dd>
                <VibeBadge class="status-badge" text-color="white" :style="{ '--status-color': task.status.color }">
                  {{ task.status.status }}
                </VibeBadge>
              </dd>

              <dt>Priority</dt>
              <dd>
                <VibeBadge v-if="task.priority" :variant="PRIORITY_VARIANT[task.priority.priority]">
                  {{ task.priority.priority }}
                </VibeBadge>
                <span v-else class="text-body-secondary">—</span>
              </dd>

              <dt>Due</dt>
              <dd :class="{ 'text-danger fw-semibold': isOverdue }">
                {{ formatDate(task.due_date) }}<span v-if="isOverdue"> (overdue)</span>
              </dd>

              <dt>Start</dt>
              <dd>{{ formatDate(task.start_date) }}</dd>

              <dt>Assignees</dt>
              <dd>{{ task.assignees.map((u) => u.username).join(', ') || '—' }}</dd>

              <dt>Watchers</dt>
              <dd>{{ task.watchers.map((u) => u.username).join(', ') || '—' }}</dd>

              <dt>Created</dt>
              <dd>{{ formatDate(task.date_created) }} by {{ task.creator.username }}</dd>

              <dt>Updated</dt>
              <dd>{{ formatDate(task.date_updated, true) }}</dd>

              <template v-if="task.date_closed">
                <dt>Closed</dt>
                <dd>{{ formatDate(task.date_closed) }}</dd>
              </template>

              <template v-if="task.points !== null">
                <dt>Points</dt>
                <dd>{{ task.points }}</dd>
              </template>

              <dt>Time</dt>
              <dd>
                {{ formatDuration(task.time_spent) }} tracked / {{ formatDuration(task.time_estimate) }} estimated
                <VibeProgress
                  v-if="timeProgress"
                  class="mt-1"
                  height="6px"
                  :bars="[{ value: timeProgress.value, variant: timeProgress.variant }]"
                />
              </dd>

              <dt>Location</dt>
              <dd>
                {{ task.folder.hidden ? '' : `${task.folder.name} / ` }}{{ task.list.name }}
                <div v-for="loc in task.locations" :key="loc.id" class="small text-body-secondary">
                  also in {{ loc.name }}
                </div>
              </dd>

              <template v-if="task.tags.length">
                <dt>Tags</dt>
                <dd class="d-flex flex-wrap gap-1">
                  <VibeBadge
                    v-for="tag in task.tags"
                    :key="tag.name"
                    class="status-badge"
                    text-color="white"
                    :style="{ '--status-color': tag.tag_bg }"
                  >
                    {{ tag.name }}
                  </VibeBadge>
                </dd>
              </template>
            </dl>
          </VibeCard>

          <VibeCard
            v-for="group in relatedGroups"
            :key="group.title"
            body-class="p-0"
          >
            <template #header>
              <VibeIcon :icon="group.icon" class="me-1" />{{ group.title }} ({{ group.ids.length }})
            </template>
            <VibeListGroup flush :items="relatedItems(group.ids)">
              <template #item="{ item, index }">
                <VibeBadge
                  v-if="related[group.ids[index] ?? '']"
                  class="status-badge me-2"
                  text-color="white"
                  :style="{ '--status-color': related[group.ids[index] ?? '']?.color }"
                >
                  {{ related[group.ids[index] ?? '']?.status }}
                </VibeBadge>
                {{ item.text }}
              </template>
            </VibeListGroup>
          </VibeCard>

          <VibeCard v-if="filledFields.length" header="Custom fields">
            <dl class="task-props mb-0">
              <template v-for="{ field, display } in filledFields" :key="field.id">
                <dt>{{ field.name }}</dt>
                <dd>
                  <a v-if="display && isUrl(display)" :href="display" target="_blank" rel="noopener">{{ display }}</a>
                  <span v-else class="comment-text">{{ display }}</span>
                </dd>
              </template>
            </dl>
            <p v-if="emptyFieldCount" class="small text-body-secondary mt-2 mb-0">
              {{ emptyFieldCount }} empty field{{ emptyFieldCount === 1 ? '' : 's' }} hidden
            </p>
          </VibeCard>
        </VibeCol>
      </VibeRow>
    </div>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  VibeAlert,
  VibeBadge,
  VibeButton,
  VibeDataTable,
  VibeDropdown,
  VibeIcon,
  VibeLink,
  VibeSpinner,
  type DataTableColumn,
  type DropdownItem,
  type Variant,
} from '@velkymx/vibeui'
import { useRoute, useRouter } from 'vue-router'
import { PRIORITY_RANK, useMyTasks } from '../composables/useMyTasks'
import { ageLabel } from '../lib/taskCache'
import { isOverdue } from '../lib/workflow'
import type { TaskRow } from '../types'

const router = useRouter()
const route = useRoute()
const { tasks, ensureLoaded, refreshFromClickUp } = useMyTasks()

const PRIORITY_VARIANT: Record<string, Variant> = {
  urgent: 'danger',
  high: 'warning',
  normal: 'primary',
  low: 'secondary',
}

const rows = computed(() => tasks.rows as TaskRow[])
// Loading until the cache read (or first fetch) lands, so the empty-state
// text doesn't flash.
const loading = computed(() => tasks.loading || !tasks.loaded)
const error = computed(() => tasks.error)
const fetchedAt = computed(() => tasks.fetchedAt)

// Ticks the "Cached Xm ago" label.
const now = ref(Date.now())
const clock = setInterval(() => (now.value = Date.now()), 30_000)
onUnmounted(() => clearInterval(clock))

onMounted(ensureLoaded)

const formatDate = (ms: unknown) =>
  typeof ms === 'number' ? new Date(ms).toLocaleDateString() : '—'

const columns: DataTableColumn<TaskRow>[] = [
  { key: 'taskId', label: 'ID', class: 'text-nowrap' },
  { key: 'name', label: 'Task' },
  { key: 'status', label: 'Status' },
  // Sorts by rank (urgent first); the cell slot shows the label, search matches it.
  { key: 'priorityRank', label: 'Priority', searchValue: (row) => row.priority },
  { key: 'list', label: 'List' },
  { key: 'due', label: 'Due', searchable: false, formatter: formatDate },
  { key: 'updated', label: 'Updated', searchable: false, formatter: formatDate },
]

// ---------- Filters ----------
// OR within a facet (new OR review), AND across facets (… AND urgent AND Whitetail).

const FILTERS_KEY = 'clickupchat.taskFilters'

type FacetKey = 'status' | 'priority' | 'list'

interface Facet {
  key: FacetKey
  label: string
  /** Option order: priority by rank, everything else alphabetical. */
  order: (a: string, b: string) => number
  optionText: (value: string) => string
}

const FACETS: Facet[] = [
  { key: 'status', label: 'Status', order: (a, b) => a.localeCompare(b), optionText: (v) => v },
  {
    key: 'priority',
    label: 'Priority',
    order: (a, b) => (PRIORITY_RANK[a] ?? 5) - (PRIORITY_RANK[b] ?? 5),
    optionText: (v) => v || 'no priority',
  },
  { key: 'list', label: 'List', order: (a, b) => a.localeCompare(b), optionText: (v) => v },
]

function loadFilters(): Record<FacetKey, string[]> {
  const empty = { status: [], priority: [], list: [] }
  try {
    return { ...empty, ...JSON.parse(localStorage.getItem(FILTERS_KEY) ?? '{}') }
  } catch {
    return empty
  }
}

/** Dashboard links pass filters as ?status=a,b&priority=…&list=… — they
 *  replace the saved filters so the link shows exactly what it promised. */
function filtersFromQuery(): Record<FacetKey, string[]> | null {
  const { status, priority, list } = route.query
  if (status === undefined && priority === undefined && list === undefined) return null
  const parse = (v: unknown) => (typeof v === 'string' && v ? v.split(',') : [])
  return { status: parse(status), priority: parse(priority), list: parse(list) }
}

const filters = ref<Record<FacetKey, string[]>>(filtersFromQuery() ?? loadFilters())

watch(
  filters,
  (value) => {
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(value))
    } catch {
      /* storage blocked — filters just won't persist */
    }
  },
  { deep: true },
)

function matches(row: TaskRow, except?: FacetKey): boolean {
  return FACETS.every(
    ({ key }) => key === except || !filters.value[key].length || filters.value[key].includes(row[key]),
  )
}

const filteredRows = computed(() => rows.value.filter((row) => matches(row)))

/** Subtasks of my tasks that are assigned to someone else. */
const othersIds = computed(() => new Set(tasks.subtasks.map((r) => r.id)))

/**
 * Filters pick the top-level rows; a shown task always carries ALL of its
 * subtasks (mine or not, matching the filters or not) as expandable sub-rows.
 * A task of mine is top-level unless one of its ancestors is shown; others'
 * subtasks only ever appear nested.
 */
const tableRows = computed(() => {
  const shownIds = new Set(filteredRows.value.map((r) => r.id))
  const byId = new Map<string, TaskRow>(
    [...rows.value, ...(tasks.subtasks as TaskRow[])].map((r) => [r.id, r]),
  )
  const childrenOf = new Map<string, TaskRow[]>()
  for (const row of byId.values()) {
    if (row.parentId && byId.has(row.parentId)) {
      childrenOf.set(row.parentId, [...(childrenOf.get(row.parentId) ?? []), row])
    }
  }
  const nestsUnderShown = (row: TaskRow) => {
    for (let id = row.parentId; id; id = byId.get(id)?.parentId ?? null) {
      if (shownIds.has(id)) return true
    }
    return false
  }
  const withChildren = (row: TaskRow): TaskRow => {
    const children = childrenOf.get(row.id)
    return children ? { ...row, children: children.map(withChildren) } : row
  }
  return filteredRows.value.filter((row) => !nestsUnderShown(row)).map(withChildren)
})

/** Dropdown items per facet. Counts respect the OTHER facets' selections,
 *  so they always say how many rows picking that option would show. */
interface FacetOption {
  value: string
  text: string
  count: number
  selected: boolean
}

const facetOptions = computed(() => {
  const out = {} as Record<FacetKey, FacetOption[]>
  for (const facet of FACETS) {
    const counts = new Map<string, number>()
    for (const row of rows.value) {
      const value = row[facet.key]
      counts.set(value, (counts.get(value) ?? 0) + (matches(row, facet.key) ? 1 : 0))
    }
    out[facet.key] = [...counts.keys()].sort(facet.order).map((value) => ({
      value,
      text: facet.optionText(value),
      count: counts.get(value) ?? 0,
      selected: filters.value[facet.key].includes(value),
    }))
  }
  return out
})

const dropdownItems = (facet: FacetKey): DropdownItem[] =>
  facetOptions.value[facet].map((o) => ({ text: o.text, active: o.selected }))

function toggleFilter(facet: FacetKey, index: number) {
  const value = facetOptions.value[facet][index]?.value
  if (value === undefined) return
  const selected = filters.value[facet]
  filters.value[facet] = selected.includes(value)
    ? selected.filter((v) => v !== value)
    : [...selected, value]
}

function facetButtonText(facet: Facet): string {
  const selected = filters.value[facet.key]
  if (!selected.length) return facet.label
  if (selected.length === 1) return `${facet.label}: ${facet.optionText(selected[0]!)}`
  return `${facet.label}: ${selected.length}`
}

// auto-close="outside" keeps a menu open across picks, but Bootstrap then
// also ignores clicks on another dropdown's toggle — close siblings by hand.
const dropdownRefs = ref<Record<string, { hide: () => void } | null>>({})

function closeOtherDropdowns(openKey: FacetKey) {
  for (const [key, dropdown] of Object.entries(dropdownRefs.value)) {
    if (key !== openKey) dropdown?.hide()
  }
}

const hasFilters = computed(() => FACETS.some(({ key }) => filters.value[key].length))

function clearFilters() {
  filters.value = { status: [], priority: [], list: [] }
}

const overdueCount = computed(() => filteredRows.value.filter(isOverdue).length)
</script>

<template>
  <main class="chat-main tasks-view">
    <header class="chat-header gap-2">
      <VibeIcon icon="list-check" />
      <h1 class="h5 mb-0 flex-grow-1">My tasks</h1>
      <VibeBadge variant="secondary" pill>
        {{ hasFilters ? `${filteredRows.length} of ${rows.length}` : rows.length }}
      </VibeBadge>
      <VibeBadge v-if="overdueCount" variant="danger" pill>{{ overdueCount }} overdue</VibeBadge>
      <span v-if="fetchedAt" class="small text-body-secondary">
        Cached {{ ageLabel(fetchedAt, now) }}
      </span>
      <VibeButton
        variant="secondary"
        outline
        size="sm"
        :disabled="loading"
        @click="refreshFromClickUp()"
      >
        <VibeSpinner v-if="loading" size="sm" class="me-1" />
        <VibeIcon v-else icon="arrow-clockwise" class="me-1" />Refresh ClickUp
      </VibeButton>
    </header>

    <div class="tasks-body pb-5">
      <VibeAlert v-if="error" variant="danger" :message="`Couldn't load tasks: ${error}`" />

      <div v-if="loading && !rows.length" class="p-5 text-center">
        <VibeSpinner variant="primary" />
      </div>

      <div v-if="rows.length" class="d-flex flex-wrap align-items-center gap-2 mb-3">
        <VibeDropdown
          v-for="facet in FACETS"
          :key="facet.key"
          :ref="(el) => (dropdownRefs[facet.key] = el as { hide: () => void } | null)"
          :text="facetButtonText(facet)"
          :variant="filters[facet.key].length ? 'primary' : 'secondary'"
          size="sm"
          auto-close="outside"
          :items="dropdownItems(facet.key)"
          @item-click="({ index }: { index: number }) => toggleFilter(facet.key, index)"
          @show="closeOtherDropdowns(facet.key)"
        >
          <template #item="{ index }">
            <span v-for="option in [facetOptions[facet.key][index]]" :key="option?.value" class="facet-option">
              <VibeIcon :icon="option?.selected ? 'check-square-fill' : 'square'" />
              <span class="flex-grow-1">{{ option?.text }}</span>
              <span class="small" :class="{ 'text-body-secondary': !option?.selected }">{{ option?.count }}</span>
            </span>
          </template>
        </VibeDropdown>
        <VibeButton v-if="hasFilters" variant="link" size="sm" @click="clearFilters()">
          <VibeIcon icon="x-lg" class="me-1" />Clear filters
        </VibeButton>
      </div>

      <VibeDataTable
        v-if="rows.length || !loading"
        :columns="columns"
        :items="tableRows"
        row-key="id"
        sort-by="priorityRank"
        multi-sort
        expandable
        :expandable-row="(item: TaskRow) => !!item.children?.length"
        show-column-toggle
        clickable
        :per-page="25"
        :per-page-options="[25, 50, 100, 200]"
        search-placeholder="Search tasks…"
        :empty-text="hasFilters ? 'No tasks match these filters.' : 'No tasks assigned to you.'"
        striped
        hover
        @row-clicked="(item: TaskRow) => router.push(`/tasks/${item.id}`)"
      >
        <!-- VibeUI 1.3 types cell(...) slot props as a union with footer(...)'s
             { column } — `'item' in cell` narrows to the row case. -->
        <template #cell(name)="cell">
          <template v-if="'item' in cell">
            <VibeIcon
              v-if="cell.item.parentId"
              icon="arrow-return-right"
              class="me-1 text-body-secondary"
              title="Subtask"
            />
            <VibeLink :to="`/tasks/${cell.item.id}`" @click.stop>{{ cell.item.name }}</VibeLink>
            <VibeBadge v-if="cell.item.children?.length" variant="secondary" pill class="ms-1">
              {{ cell.item.children.length }}
            </VibeBadge>
            <VibeIcon
              v-if="othersIds.has(cell.item.id)"
              icon="person-dash"
              class="ms-1 text-body-secondary"
              title="Not assigned to you"
            />
          </template>
        </template>
        <template #cell(status)="cell">
          <VibeBadge
            v-if="'item' in cell"
            class="status-badge"
            text-color="white"
            :style="{ '--status-color': cell.item.statusColor }"
          >
            {{ cell.item.status }}
          </VibeBadge>
        </template>
        <template #cell(priorityRank)="cell">
          <template v-if="'item' in cell">
            <VibeBadge v-if="cell.item.priority" :variant="PRIORITY_VARIANT[cell.item.priority]">
              {{ cell.item.priority }}
            </VibeBadge>
            <span v-else class="text-body-secondary">—</span>
          </template>
        </template>
        <template #cell(due)="cell">
          <span v-if="'item' in cell" :class="{ 'text-danger fw-semibold': isOverdue(cell.item) }">
            {{ formatDate(cell.item.due) }}
          </span>
        </template>
      </VibeDataTable>
    </div>
  </main>
</template>

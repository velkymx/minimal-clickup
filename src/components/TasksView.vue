<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  createColumnHelper,
  createExpandedRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  FlexRender,
  functionalUpdate,
  rowExpandingFeature,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_text,
  tableFeatures,
  useTable,
  type PaginationState,
  type SortingState,
} from '@tanstack/vue-table'
import {
  VibeAlert,
  VibeBadge,
  VibeButton,
  VibeDropdown,
  VibeFormSwitch,
  VibeIcon,
  VibeLink,
  VibePagination,
  VibeSpinner,
  type DropdownItem,
} from '@velkymx/vibeui'
import { useRoute, useRouter } from 'vue-router'
import { PRIORITY_RANK, useMyTasks } from '../composables/useMyTasks'
import { ageLabel } from '../lib/taskCache'
import { isOpen, isOverdue } from '../lib/workflow'
import type { TaskRow } from '../types'

const router = useRouter()
const route = useRoute()
const { tasks, ensureLoaded, refreshFromClickUp } = useMyTasks()

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

// ---------- Tree ----------
// Subtasks nest under their parent. Parents that aren't assigned to me (or
// that the filters hide) still show, dimmed, as the path to a match.

/** Why a row is shown only as context; '' = it's one of my matching tasks. */
type ContextReason = '' | 'unassigned' | 'filtered'

type TreeRow = TaskRow & { subRows: TreeRow[]; context: ContextReason }

const CONTEXT_TITLE: Record<ContextReason, string | undefined> = {
  '': undefined,
  unassigned: 'Parent task — not assigned to you',
  filtered: "Parent task — doesn't match your filters",
}

const byId = computed(
  () => new Map([...(tasks.ancestors as TaskRow[]), ...rows.value].map((r) => [r.id, r])),
)

/** Parent, grandparent, … as far up as we have them. */
function ancestorsOf(row: TaskRow): TaskRow[] {
  const chain: TaskRow[] = []
  let parent = row.parentId ? byId.value.get(row.parentId) : undefined
  while (parent && !chain.includes(parent)) {
    chain.push(parent)
    parent = parent.parentId ? byId.value.get(parent.parentId) : undefined
  }
  return chain
}

const search = ref('')

/** A row matches on its own ID/name/status/list, or on a parent's ID or
 *  name — so searching a parent lists its subtasks. */
function matchesSearch(row: TaskRow): boolean {
  const q = search.value.trim().toLowerCase()
  if (!q) return true
  const has = (text: string) => text.toLowerCase().includes(q)
  return (
    [row.taskId, row.name, row.status, row.list].some(has) ||
    ancestorsOf(row).some((a) => has(a.taskId) || has(a.name))
  )
}

const tree = computed<TreeRow[]>(() => {
  const assigned = new Set(rows.value.map((r) => r.id))
  const nodes = new Map<string, TreeRow>()
  for (const row of filteredRows.value) nodes.set(row.id, { ...row, subRows: [], context: '' })
  for (const row of filteredRows.value) {
    for (const a of ancestorsOf(row)) {
      if (!nodes.has(a.id)) {
        nodes.set(a.id, { ...a, subRows: [], context: assigned.has(a.id) ? 'filtered' : 'unassigned' })
      }
    }
  }
  const roots: TreeRow[] = []
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined
    ;(parent ? parent.subRows : roots).push(node)
  }
  return roots
})

const parentIds = computed(() => {
  const ids: string[] = []
  const walk = (list: TreeRow[]) =>
    list.forEach((n) => {
      if (n.subRows.length) ids.push(n.id)
      walk(n.subRows)
    })
  walk(tree.value)
  return ids
})

// Everything starts expanded; only the parents you collapse are remembered.
const COLLAPSED_KEY = 'clickupchat.collapsedTasks'

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'))
  } catch {
    return new Set()
  }
}

const collapsed = ref(loadCollapsed())

watch(collapsed, (ids) => {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...ids]))
  } catch {
    /* storage blocked — collapsed groups just won't persist */
  }
})

function toggleCollapsed(id: string) {
  const next = new Set(collapsed.value)
  if (!next.delete(id)) next.add(id)
  collapsed.value = next
}

const expandAll = () => (collapsed.value = new Set())
const collapseAll = () => (collapsed.value = new Set([...collapsed.value, ...parentIds.value]))

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

// Completed = not open per lib/workflow (closed, complete, approved). Hidden
// by default — the table is mostly for what's still on my plate.
const SHOW_COMPLETED_KEY = 'clickupchat.showCompleted'

function loadShowCompleted(): boolean {
  try {
    return localStorage.getItem(SHOW_COMPLETED_KEY) === '1'
  } catch {
    return false
  }
}

const showCompleted = ref(loadShowCompleted())

watch(showCompleted, (on) => {
  try {
    localStorage.setItem(SHOW_COMPLETED_KEY, on ? '1' : '0')
  } catch {
    /* storage blocked — the toggle just won't persist */
  }
})

function matches(row: TaskRow, except?: FacetKey): boolean {
  return (
    FACETS.every(
      ({ key }) => key === except || !filters.value[key].length || filters.value[key].includes(row[key]),
    ) &&
    // Picking a completed status in the Status filter shows it even with the
    // toggle off — so that facet's own counts skip this check.
    (showCompleted.value || isOpen(row) || except === 'status' || filters.value.status.includes(row.status))
  )
}

const filteredRows = computed(() => rows.value.filter((row) => matches(row) && matchesSearch(row)))

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
      counts.set(value, (counts.get(value) ?? 0) + (matches(row, facet.key) && matchesSearch(row) ? 1 : 0))
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

// ---------- Table ----------

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text, basic: sortFn_basic },
  rowExpandingFeature,
  expandedRowModel: createExpandedRowModel(),
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
})

const helper = createColumnHelper<typeof features, TreeRow>()
const columns = helper.columns([
  helper.accessor('taskId', { header: 'ID', sortFn: 'alphanumeric' }),
  helper.accessor('name', { header: 'Task', sortFn: 'text' }),
  helper.accessor('status', { header: 'Status', sortFn: 'text' }),
  // Sorts by rank (urgent first); the cell shows the label.
  helper.accessor('priorityRank', { header: 'Priority', sortFn: 'basic' }),
  helper.accessor('list', { header: 'List', sortFn: 'text' }),
  // undefined, not null — sortUndefined only recognizes undefined.
  helper.accessor((r) => r.due ?? undefined, {
    id: 'due',
    header: 'Due',
    sortFn: 'basic',
    sortUndefined: 'last',
  }),
  helper.accessor('updated', { header: 'Updated', sortFn: 'basic' }),
])

const sorting = ref<SortingState>([{ id: 'priorityRank', desc: false }])
const pagination = ref<PaginationState>({ pageIndex: 0, pageSize: 25 })
const PAGE_SIZES = [25, 50, 100, 200]

const table = useTable({
  features,
  columns,
  data: tree,
  getRowId: (row: TreeRow) => row.id,
  getSubRows: (row: TreeRow) => row.subRows,
  state: computed(() => ({
    sorting: sorting.value,
    pagination: pagination.value,
    expanded: Object.fromEntries(parentIds.value.map((id) => [id, !collapsed.value.has(id)])),
  })),
  onSortingChange: (next) => (sorting.value = functionalUpdate(next, sorting.value)),
  onPaginationChange: (next) => (pagination.value = functionalUpdate(next, pagination.value)),
  enableSortingRemoval: false,
  sortDescFirst: false,
  // Subtasks always render on their parent's page; pages count top-level rows.
  paginateExpandedRows: false,
  // The default resets expansion whenever data changes — every filter click
  // would collapse the tree.
  autoResetExpanded: false,
})

const ariaSort = (dir: false | 'asc' | 'desc') =>
  dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'

const pageRange = computed(() => {
  const total = table.getRowCount()
  const { pageIndex, pageSize } = pagination.value
  const start = Math.min(pageIndex * pageSize + 1, total)
  return { start, end: Math.min(start + pageSize - 1, total), total }
})
</script>

<template>
  <main class="chat-main tasks-view">
    <header class="chat-header gap-2">
      <VibeIcon icon="list-check" />
      <h1 class="h5 mb-0 flex-grow-1">My tasks</h1>
      <VibeBadge variant="secondary" pill>
        {{ filteredRows.length < rows.length ? `${filteredRows.length} of ${rows.length}` : rows.length }}
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

    <div class="tasks-body">
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
        <div class="completed-toggle ms-2" title="Closed, complete and approved tasks">
          <VibeFormSwitch v-model="showCompleted" label="Show completed" />
        </div>
        <VibeButton v-if="hasFilters" variant="link" size="sm" @click="clearFilters()">
          <VibeIcon icon="x-lg" class="me-1" />Clear filters
        </VibeButton>
        <div v-if="parentIds.length" class="ms-auto d-flex gap-1">
          <VibeButton variant="secondary" outline size="sm" @click="expandAll()">
            <VibeIcon icon="arrows-expand" class="me-1" />Expand all
          </VibeButton>
          <VibeButton variant="secondary" outline size="sm" @click="collapseAll()">
            <VibeIcon icon="arrows-collapse" class="me-1" />Collapse all
          </VibeButton>
        </div>
      </div>

      <template v-if="rows.length || !loading">
        <div class="row mb-3">
          <div class="col-md-6 mb-2 mb-md-0">
            <input
              v-model="search"
              type="search"
              class="form-control"
              placeholder="Search tasks or their parents…"
            />
          </div>
          <div class="col-md-6 d-flex justify-content-md-end align-items-center">
            <label class="me-2 mb-0" for="tasks-page-size">Show</label>
            <select
              id="tasks-page-size"
              class="form-select form-select-sm w-auto"
              :value="pagination.pageSize"
              @change="table.setPageSize(Number(($event.target as HTMLSelectElement).value))"
            >
              <option v-for="size in PAGE_SIZES" :key="size" :value="size">{{ size }}</option>
            </select>
            <span class="ms-2">per page</span>
          </div>
        </div>

        <div class="table-responsive">
          <table class="tasks-tree">
            <!-- Name width is the mock's; List takes whatever is left. -->
            <colgroup>
              <col style="width: 96px" />
              <col style="width: 480px" />
              <col style="width: 136px" />
              <col style="width: 104px" />
              <col />
              <col style="width: 104px" />
              <col style="width: 112px" />
            </colgroup>
            <thead>
              <tr v-for="group in table.getHeaderGroups()" :key="group.id">
                <th
                  v-for="header in group.headers"
                  :key="header.id"
                  :aria-sort="ariaSort(header.column.getIsSorted())"
                  @click="header.column.getToggleSortingHandler()?.($event)"
                >
                  <FlexRender :header="header" />
                  <span
                    class="sort-icon ms-1"
                    :class="header.column.getIsSorted() && `sort-${header.column.getIsSorted()}`"
                    aria-hidden="true"
                  />
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in table.getRowModel().rows"
                :key="row.id"
                :class="{ 'row-dim': row.original.context || !isOpen(row.original) }"
                :title="CONTEXT_TITLE[row.original.context]"
                @click="router.push(`/tasks/${row.original.id}`)"
              >
                <td class="c-id">{{ row.original.taskId }}</td>
                <td>
                  <div class="tree-cell" :style="{ paddingLeft: `${row.depth * 1.5}rem` }">
                    <button
                      v-if="row.subRows.length"
                      type="button"
                      class="tree-toggle"
                      :aria-expanded="row.getIsExpanded()"
                      :aria-label="`${row.getIsExpanded() ? 'Collapse' : 'Expand'} ${row.original.name}`"
                      @click.stop="toggleCollapsed(row.id)"
                    >
                      <VibeIcon :icon="row.getIsExpanded() ? 'chevron-down' : 'chevron-right'" />
                    </button>
                    <span v-else class="tree-toggle" aria-hidden="true" />
                    <VibeLink :to="`/tasks/${row.original.id}`" :title="row.original.name" @click.stop>
                      {{ row.original.name }}
                    </VibeLink>
                    <span
                      v-if="row.subRows.length"
                      class="child-count"
                      :title="`${row.subRows.length} subtasks shown`"
                    >
                      {{ row.subRows.length }}
                    </span>
                  </div>
                </td>
                <td>
                  <span class="status-pill" :style="{ '--status-color': row.original.statusColor }">
                    {{ row.original.status }}
                  </span>
                </td>
                <td>
                  <span v-if="row.original.priority" class="prio" :class="`prio-${row.original.priority}`">
                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                      <path
                        d="M2.5 11.25V1.25"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                      />
                      <path d="M3 1.75h6.5L8 4.25l1.5 2.5H3z" fill="currentColor" />
                    </svg>
                    {{ row.original.priority }}
                  </span>
                  <span v-else class="c-empty">—</span>
                </td>
                <td class="c-list">{{ row.original.list }}</td>
                <td :class="row.original.due === null ? 'c-empty' : 'c-date'">
                  <span :class="{ 'text-danger fw-semibold': isOverdue(row.original) }">
                    {{ formatDate(row.original.due) }}
                  </span>
                </td>
                <td class="c-date">{{ formatDate(row.original.updated) }}</td>
              </tr>
              <tr v-if="!table.getRowModel().rows.length">
                <td :colspan="columns.length" class="c-empty text-center py-3">
                  {{ rows.length ? 'No tasks match these filters.' : 'No tasks assigned to you.' }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="pageRange.total" class="d-flex flex-wrap justify-content-between align-items-center gap-2">
          <span class="small text-body-secondary">
            Showing {{ pageRange.start }} to {{ pageRange.end }} of {{ pageRange.total }} top-level tasks
          </span>
          <VibePagination
            v-if="table.getPageCount() > 1"
            size="sm"
            :total-pages="table.getPageCount()"
            :current-page="pagination.pageIndex + 1"
            @update:current-page="(page: number) => table.setPageIndex(page - 1)"
          />
        </div>
      </template>
    </div>
  </main>
</template>

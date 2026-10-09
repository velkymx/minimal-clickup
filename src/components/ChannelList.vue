<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import {
  VibeBadge,
  VibeCollapse,
  VibeIcon,
  VibeListGroup,
  VibeSpinner,
  type ListGroupItem,
} from '@velkymx/vibeui'
import { UNREAD_UNKNOWN, useChat } from '../composables/useChat'
import type { ChatChannel } from '../types'

const EXPANDED_KEY = 'clickupchat.sections'

/** Pinned / Channels / DMs with unread badges. Used by the chat page's
 *  sidebar and the dock's Messaging panel — each decides what a click does. */
const emit = defineEmits<{ select: [channelId: string] }>()

const { state, togglePin } = useChat()

function byName(a: ChatChannel, b: ChatChannel): number {
  const nameA = a.displayName || a.name || ''
  const nameB = b.displayName || b.name || ''
  return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' })
}

const isPinned = (id: string) => state.pinned.includes(id)

const pinnedChannels = computed(() =>
  state.channels.filter((c) => isPinned(c.id)).sort(byName),
)
const channels = computed(() =>
  state.channels
    .filter((c) => c.type === 'CHANNEL' && !isPinned(c.id))
    .sort(byName),
)
const dms = computed(() =>
  state.channels
    .filter((c) => c.type !== 'CHANNEL' && !isPinned(c.id))
    .sort(byName),
)

interface Section {
  key: string
  title: string
  list: readonly ChatChannel[]
}

const sections = computed<Section[]>(() =>
  [
    { key: 'pinned', title: 'Pinned', list: pinnedChannels.value },
    { key: 'channels', title: 'Channels', list: channels.value },
    { key: 'dms', title: 'Direct messages', list: dms.value },
  ].filter((s) => s.list.length),
)

// Collapsed/expanded per section, persisted.
const expanded = reactive<Record<string, boolean>>({
  pinned: true,
  channels: true,
  dms: true,
  ...(() => {
    try {
      return JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? '{}')
    } catch {
      return {}
    }
  })(),
})
watch(expanded, () =>
  localStorage.setItem(EXPANDED_KEY, JSON.stringify(expanded)),
)

function unreadCountOf(channel?: ChatChannel): number {
  return channel ? state.unread[channel.id] ?? 0 : 0
}

function unreadLabel(channel?: ChatChannel): string {
  const count = unreadCountOf(channel)
  if (!count) return ''
  if (count === UNREAD_UNKNOWN) return '●'
  return count >= 10 ? '9+' : String(count)
}

function sectionUnread(section: Section): number {
  return section.list.reduce((sum, c) => {
    const n = unreadCountOf(c)
    return sum + (n === UNREAD_UNKNOWN ? 1 : n)
  }, 0)
}

function toItems(list: readonly ChatChannel[]): ListGroupItem[] {
  return list.map((c) => ({
    text: c.displayName || c.name || 'unnamed',
    active: c.id === state.activeChannelId,
  }))
}

function iconFor(channel?: ChatChannel): string {
  return channel?.type === 'CHANNEL' ? 'hash' : 'person-fill'
}

function onItemClick(section: Section, index: number) {
  const channel = section.list[index]
  if (channel) emit('select', channel.id)
}
</script>

<template>
  <div class="channel-list">
    <div v-if="state.loadingChannels && !state.channels.length" class="p-3 text-center">
      <VibeSpinner size="sm" />
    </div>

    <template v-for="section in sections" :key="section.key">
      <button
        type="button"
        class="sidebar-section text-body-secondary"
        @click="expanded[section.key] = !expanded[section.key]"
      >
        <VibeIcon
          :icon="expanded[section.key] ? 'chevron-down' : 'chevron-right'"
          class="me-1"
        />
        {{ section.title }}
        <VibeBadge
          v-if="!expanded[section.key] && sectionUnread(section)"
          variant="danger"
          pill
          class="ms-1"
        >
          {{ sectionUnread(section) > 99 ? '99+' : sectionUnread(section) }}
        </VibeBadge>
      </button>
      <VibeCollapse v-model="expanded[section.key]">
        <VibeListGroup
          flush
          :items="toItems(section.list)"
          @item-click="({ index }: { index: number }) => onItemClick(section, index)"
        >
          <template #item="{ item, index }">
            <span
              class="channel-item"
              :class="{ 'channel-unread': unreadLabel(section.list[index]) }"
            >
              <VibeIcon :icon="iconFor(section.list[index])" class="me-1" />
              <span class="channel-name">{{ item.text }}</span>
              <VibeBadge v-if="unreadLabel(section.list[index])" variant="danger" pill>
                {{ unreadLabel(section.list[index]) }}
              </VibeBadge>
              <button
                type="button"
                class="pin-btn"
                :class="{ pinned: isPinned(section.list[index]?.id ?? '') }"
                :title="isPinned(section.list[index]?.id ?? '') ? 'Unpin' : 'Pin to top'"
                @click.stop="togglePin(section.list[index]?.id ?? '')"
              >
                <VibeIcon
                  :icon="isPinned(section.list[index]?.id ?? '') ? 'pin-angle-fill' : 'pin-angle'"
                />
              </button>
            </span>
          </template>
        </VibeListGroup>
      </VibeCollapse>
    </template>
  </div>
</template>

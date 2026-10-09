<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  VibeBadge,
  VibeIcon,
  VibeNavbar,
  VibeNavbarBrand,
  VibeNavbarNav,
  useColorMode,
  type NavItem,
} from '@velkymx/vibeui'
import { useRoute } from 'vue-router'
import { UNREAD_UNKNOWN, useChat } from '../composables/useChat'
import { apiHealth } from '../lib/clickup'
import DebugPanel from './DebugPanel.vue'

const { state, disconnect, toggleSound } = useChat()
const { colorMode, toggleColorMode } = useColorMode()
const route = useRoute()

const totalUnread = computed(() =>
  Object.values(state.unread).reduce(
    (sum, n) => sum + (n === UNREAD_UNKNOWN ? 1 : n),
    0,
  ),
)

const onChatPage = computed(() => route.path === '/' || route.path.startsWith('/channel/'))

const pages = computed<NavItem[]>(() => [
  { text: 'Chat', to: '/', active: onChatPage.value },
  { text: 'Dashboard', to: '/dashboard', active: route.path === '/dashboard' },
  { text: 'My tasks', to: '/tasks', active: route.path.startsWith('/tasks') },
])
const pageIcons = ['chat-dots', 'speedometer2', 'list-check']

const showDebug = ref(false)
const connectionDegraded = computed(() => apiHealth.consecutiveFailures >= 3)

const modeIcon = computed(() =>
  colorMode.value === 'dark' ? 'moon-stars-fill' : colorMode.value === 'light' ? 'sun-fill' : 'circle-half',
)

// Right side: plain button items, then the user menu.
const tools = computed<NavItem[]>(() => [
  { text: connectionDegraded.value ? 'Connection issues — open diagnostics' : 'Diagnostics' },
  { text: state.soundOn ? 'Chime on — click to mute' : 'Chime off — click to unmute' },
  { text: `Color mode: ${colorMode.value}` },
  { text: state.me?.username ?? 'Me', children: [{ text: 'Sign out' }] },
])
const toolIcons = computed(() => [
  connectionDegraded.value ? 'exclamation-triangle-fill' : 'bug',
  state.soundOn ? 'bell-fill' : 'bell-slash',
  modeIcon.value,
])

function onToolClick({ index }: { index: number }) {
  if (index === 0) showDebug.value = true
  else if (index === 1) toggleSound()
  else if (index === 2) toggleColorMode()
}
</script>

<template>
  <header class="app-header">
    <VibeNavbar expand class="border-bottom px-1">
      <VibeNavbarBrand to="/">
        {{ state.workspaceName || 'ClickUp Chat' }}
      </VibeNavbarBrand>

      <VibeNavbarNav :items="pages" class="me-auto">
        <template #item="{ item, index }">
          <VibeIcon :icon="pageIcons[index]" class="me-1" />
          {{ item.text }}
          <VibeBadge v-if="index === 0 && totalUnread" variant="danger" pill class="ms-1">
            {{ totalUnread > 99 ? '99+' : totalUnread }}
          </VibeBadge>
        </template>
      </VibeNavbarNav>

      <VibeNavbarNav
        :items="tools"
        class="flex-row align-items-center gap-1"
        @item-click="onToolClick"
        @dropdown-item-click="disconnect()"
      >
        <template #item="{ item, index }">
          <template v-if="index < toolIcons.length">
            <span :title="item.text">
              <VibeIcon
                :icon="toolIcons[index]"
                :class="index === 0 && connectionDegraded ? 'text-danger' : ''"
              />
            </span>
          </template>
          <template v-else>
            <img
              v-if="state.me?.profilePicture"
              class="avatar avatar-sm me-1"
              :src="state.me.profilePicture"
              :alt="state.me.username"
            />
            <span
              v-else-if="state.me"
              class="avatar avatar-sm avatar-initials d-inline-flex me-1"
              :style="{ backgroundColor: state.me.color }"
            >
              {{ state.me.initials }}
            </span>
            {{ item.text }}
          </template>
        </template>
        <template #dropdown-item="{ child }">
          <VibeIcon icon="box-arrow-right" class="me-1" />{{ child.text }}
        </template>
      </VibeNavbarNav>
    </VibeNavbar>

    <div
      v-if="connectionDegraded"
      class="connection-banner"
      role="alert"
      @click="showDebug = true"
    >
      <VibeIcon icon="wifi-off" class="me-1" />
      ClickUp connection issues — {{ apiHealth.consecutiveFailures }} failed calls.
      Click for details.
    </div>

    <DebugPanel v-model="showDebug" />
  </header>
</template>

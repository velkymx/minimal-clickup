<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { VibeBadge, VibeCard, VibeIcon } from '@velkymx/vibeui'
import { UNREAD_UNKNOWN, useChat } from '../composables/useChat'
import ChannelList from './ChannelList.vue'
import ChatBox from './ChatBox.vue'

const OPEN_KEY = 'clickupchat.messagingOpen'

/** Bottom-right chat dock: conversation boxes + the Messaging tab. */
const { state, openBox } = useChat()

const listOpen = ref(localStorage.getItem(OPEN_KEY) === '1')
watch(listOpen, (open) => localStorage.setItem(OPEN_KEY, open ? '1' : '0'))

const totalUnread = computed(() =>
  Object.values(state.unread).reduce(
    (sum, n) => sum + (n === UNREAD_UNKNOWN ? 1 : n),
    0,
  ),
)

function pick(channelId: string) {
  openBox(channelId).catch(() => {/* box shows empty; next poll retries */})
}
</script>

<template>
  <div class="chat-dock">
    <VibeCard
      class="messaging-tab shadow"
      header-class="chat-box-header"
      :body-class="listOpen ? 'messaging-body' : 'd-none'"
    >
      <template #header>
        <button
          type="button"
          class="chat-box-title"
          :title="listOpen ? 'Collapse' : 'Show conversations'"
          @click="listOpen = !listOpen"
        >
          <VibeIcon icon="chat-dots-fill" class="me-2" />
          <span class="channel-name">Messaging</span>
          <VibeBadge v-if="totalUnread" variant="danger" pill class="ms-1">
            {{ totalUnread > 99 ? '99+' : totalUnread }}
          </VibeBadge>
          <VibeIcon :icon="listOpen ? 'chevron-down' : 'chevron-up'" class="ms-2" />
        </button>
      </template>
      <ChannelList v-if="listOpen" @select="pick" />
    </VibeCard>

    <!-- Dock lays out right → left: newest box sits next to the tab. -->
    <ChatBox v-for="box in [...state.boxes].reverse()" :key="box.channelId" :box="box" />
  </div>
</template>

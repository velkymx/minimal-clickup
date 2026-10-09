<script setup lang="ts">
import { computed, nextTick, ref, watch, type DeepReadonly } from 'vue'
import {
  VibeBadge,
  VibeButton,
  VibeCard,
  VibeCloseButton,
  VibeFormTextarea,
  VibeIcon,
  VibeSpinner,
  useToast,
} from '@velkymx/vibeui'
import { useRouter } from 'vue-router'
import { UNREAD_UNKNOWN, useChat } from '../composables/useChat'
import { markdownToSafeHtml } from '../lib/markdown'
import type { ChatBox, PendingSend } from '../types'
import MessageItem from './MessageItem.vue'

/** One docked conversation (LinkedIn / Google Chat style). */
const props = defineProps<{ box: DeepReadonly<ChatBox> }>()

const { state, memberFor, send, undoSend, sendNow, closeBox, toggleBox } = useChat()
const router = useRouter()
const toast = useToast()

const COMPACT_WINDOW_MS = 5 * 60 * 1000

const channel = computed(() => state.channels.find((c) => c.id === props.box.channelId))
const title = computed(() => channel.value?.displayName || channel.value?.name || 'Chat')

const unread = computed(() => {
  const n = state.unread[props.box.channelId] ?? 0
  if (!n) return ''
  return n === UNREAD_UNKNOWN ? '●' : n >= 10 ? '9+' : String(n)
})

function isCompact(index: number): boolean {
  const current = props.box.messages[index]
  const previous = props.box.messages[index - 1]
  if (!previous || !current.user_id) return false
  return (
    previous.user_id === current.user_id &&
    current.date - previous.date < COMPACT_WINDOW_MS
  )
}

// ---------- Pending sends (undo window) ----------

const pendingHere = computed(() =>
  state.pending.filter((p) => p.channelId === props.box.channelId && !p.threadParentId),
)

function secondsLeft(item: PendingSend): number {
  return Math.max(0, Math.ceil((item.sendAt - state.nowTick) / 1000))
}

function undo(item: PendingSend) {
  const restored = undoSend(item.id)
  if (restored) draft.value = restored.content
}

async function deliverNow(item: PendingSend) {
  try {
    await sendNow(item.id)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'Failed to send message.')
  }
}

// ---------- Scroll + composer ----------

const scroller = ref<HTMLElement | null>(null)

// Box opened/expanded or new messages → show the latest.
watch(
  () => [props.box.minimized, props.box.messages.length + pendingHere.value.length],
  async () => {
    await nextTick()
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  },
  { immediate: true },
)

const draft = ref('')

function submit() {
  const text = draft.value
  if (!text.trim()) return
  draft.value = ''
  send(text, undefined, props.box.channelId) // queued — undo window starts
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    submit()
  }
}

function openFull() {
  const id = props.box.channelId
  closeBox(id)
  router.push(`/channel/${id}`)
}
</script>

<template>
  <VibeCard
    class="chat-box shadow"
    :class="{ minimized: box.minimized }"
    header-class="chat-box-header"
    :body-class="box.minimized ? 'd-none' : 'chat-box-body'"
    :footer-class="box.minimized ? 'd-none' : 'chat-box-footer'"
  >
    <template #header>
      <button
        type="button"
        class="chat-box-title"
        :class="{ 'channel-unread': unread }"
        :title="box.minimized ? 'Expand' : 'Minimize'"
        @click="toggleBox(box.channelId)"
      >
        <VibeIcon :icon="channel?.type === 'CHANNEL' ? 'hash' : 'person-fill'" class="me-1" />
        <span class="channel-name">{{ title }}</span>
        <VibeBadge v-if="unread" variant="danger" pill class="ms-1">{{ unread }}</VibeBadge>
      </button>
      <VibeButton
        variant="secondary"
        outline
        size="sm"
        class="border-0"
        title="Open in full chat"
        @click="openFull"
      >
        <VibeIcon icon="box-arrow-up-right" />
      </VibeButton>
      <VibeCloseButton class="ms-1" aria-label="Close chat" @click="closeBox(box.channelId)" />
    </template>

    <template #default>
      <div v-if="!box.minimized" ref="scroller" class="chat-box-scroll">
        <div v-if="box.loading" class="p-3 text-center">
          <VibeSpinner size="sm" />
        </div>
        <div v-else-if="!box.messages.length" class="p-3 text-center text-body-secondary">
          No messages yet. Say hi 👋
        </div>
        <!-- in-thread: no thread panel here — "Open in full chat" for replies -->
        <MessageItem
          v-for="(message, index) in box.messages"
          :key="message.id"
          :message="message"
          :member="memberFor(message.user_id)"
          :compact="isCompact(index)"
          :mine="message.user_id === state.me?.id"
          in-thread
        />

        <div v-for="item in pendingHere" :key="item.id" class="pending-row">
          <!-- eslint-disable-next-line vue/no-v-html — own content, sanitized -->
          <div class="pending-content" v-html="markdownToSafeHtml(item.content)"></div>
          <div class="pending-controls">
            <span v-if="item.failed" class="text-danger small">Send failed.</span>
            <span v-else class="text-body-secondary small">
              Sending in {{ secondsLeft(item) }}s…
            </span>
            <VibeButton size="sm" variant="secondary" outline @click="undo(item)">
              Undo
            </VibeButton>
            <VibeButton size="sm" variant="primary" :disabled="item.dispatching" @click="deliverNow(item)">
              {{ item.failed ? 'Retry' : 'Send now' }}
            </VibeButton>
          </div>
        </div>
      </div>
    </template>

    <template #footer>
      <div class="d-flex align-items-end gap-2" @keydown="onKeydown">
        <VibeFormTextarea
          v-model="draft"
          class="flex-grow-1 mb-0"
          :rows="2"
          no-resize
          :placeholder="`Message ${title}… (Enter to send)`"
        />
        <VibeButton
          variant="primary"
          :disabled="!draft.trim()"
          title="Send (Enter) — 60s undo window"
          @click="submit"
        >
          <VibeIcon icon="send-fill" />
        </VibeButton>
      </div>
    </template>
  </VibeCard>
</template>

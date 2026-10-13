<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch, type DeepReadonly } from 'vue'
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
import { useTextareaMentions } from '../composables/useMentionSuggest'
import { markdownToSafeHtml } from '../lib/markdown'
import type { ChatBox, ChatMessage, PendingSend } from '../types'
import MentionMenu from './MentionMenu.vue'
import MessageItem from './MessageItem.vue'

/** One docked conversation (LinkedIn / Google Chat style). */
const props = defineProps<{ box: DeepReadonly<ChatBox> }>()

const {
  state,
  memberFor,
  send,
  undoSend,
  sendNow,
  closeBox,
  toggleBox,
  openBoxThread,
  closeBoxThread,
  sendThreadReply,
} = useChat()
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

function isCompact(list: readonly DeepReadonly<ChatMessage>[], index: number): boolean {
  const current = list[index]
  const previous = list[index - 1]
  if (!previous || !current.user_id) return false
  return (
    previous.user_id === current.user_id &&
    current.date - previous.date < COMPACT_WINDOW_MS
  )
}

// ---------- Thread ----------

const thread = computed(() => props.box.thread)

async function showThread(message: ChatMessage) {
  try {
    await openBoxThread(props.box.channelId, message)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'Failed to load replies.')
  }
}

// ---------- Pending sends (undo window) ----------

/** Queued in the open view: conversation (no parent) or the thread's replies. */
const pendingShown = computed(() =>
  state.pending.filter(
    (p) =>
      p.channelId === props.box.channelId && p.threadParentId === thread.value?.parent.id,
  ),
)

function secondsLeft(item: PendingSend): number {
  return Math.max(0, Math.ceil((item.sendAt - state.nowTick) / 1000))
}

function undo(item: PendingSend) {
  const restored = undoSend(item.id)
  if (!restored) return
  const text = restored.draft ?? restored.content
  if (restored.threadParentId) replyDraft.value = text
  else draft.value = text
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

// Box opened/expanded, view switched or new messages → show the latest.
watch(
  () => [
    props.box.minimized,
    thread.value?.parent.id,
    props.box.messages.length + (thread.value?.replies.length ?? 0) + pendingShown.value.length,
  ],
  async () => {
    await nextTick()
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  },
  { immediate: true },
)

const draft = ref('')
const replyDraft = ref('')

/** The composer edits the reply draft while a thread is open. */
const composerDraft = computed({
  get: () => (thread.value ? replyDraft.value : draft.value),
  set: (value: string) => {
    if (thread.value) replyDraft.value = value
    else draft.value = value
  },
})

const composer = ref<HTMLElement | null>(null)
const mention = reactive(useTextareaMentions(composer, composerDraft))

function submit() {
  const text = composerDraft.value
  if (!text.trim()) return
  composerDraft.value = ''
  // Queued — undo window starts.
  if (thread.value) sendThreadReply(text, thread.value.parent.id, props.box.channelId)
  else send(text, undefined, props.box.channelId)
}

function onKeydown(event: KeyboardEvent) {
  if (mention.handleKey(event)) return
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
        <!-- Thread view: parent + replies -->
        <template v-if="thread">
          <div class="sticky-top d-flex align-items-center gap-2 px-2 py-1 bg-body border-bottom">
            <VibeButton
              variant="secondary"
              outline
              size="sm"
              class="border-0"
              title="Back to conversation"
              @click="closeBoxThread(box.channelId)"
            >
              <VibeIcon icon="arrow-left" class="me-1" />Back
            </VibeButton>
            <span class="fw-semibold small">Thread</span>
          </div>
          <MessageItem
            :message="thread.parent"
            :member="memberFor(thread.parent.user_id)"
            :compact="false"
            :mine="thread.parent.user_id === state.me?.id"
            in-thread
          />
          <div class="thread-divider text-body-secondary mx-3">
            {{ thread.replies.length }}
            {{ thread.replies.length === 1 ? 'reply' : 'replies' }}
          </div>
          <div v-if="thread.loading" class="p-3 text-center">
            <VibeSpinner size="sm" />
          </div>
          <div v-else-if="!thread.replies.length" class="p-3 text-center text-body-secondary">
            No replies yet.
          </div>
          <MessageItem
            v-for="(reply, index) in thread.replies"
            :key="reply.id"
            :message="reply"
            :member="memberFor(reply.user_id)"
            :compact="isCompact(thread.replies, index)"
            :mine="reply.user_id === state.me?.id"
            in-thread
          />
        </template>

        <!-- Conversation view -->
        <template v-else>
          <div v-if="box.loading" class="p-3 text-center">
            <VibeSpinner size="sm" />
          </div>
          <div v-else-if="!box.messages.length" class="p-3 text-center text-body-secondary">
            No messages yet. Say hi 👋
          </div>
          <MessageItem
            v-for="(message, index) in box.messages"
            :key="message.id"
            :message="message"
            :member="memberFor(message.user_id)"
            :compact="isCompact(box.messages, index)"
            :mine="message.user_id === state.me?.id"
            @open-thread="showThread"
          />
        </template>

        <div v-for="item in pendingShown" :key="item.id" class="pending-row">
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
      <div
        ref="composer"
        class="position-relative d-flex align-items-end gap-2"
        @keydown="onKeydown"
        @input="mention.track"
        @click="mention.track"
        @keyup="mention.track"
      >
        <MentionMenu :matches="mention.matches" :active="mention.active" @pick="mention.pick" />
        <VibeFormTextarea
          v-model="composerDraft"
          class="flex-grow-1 mb-0"
          :rows="2"
          no-resize
          :placeholder="thread ? 'Reply… (Enter to send)' : `Message ${title}… (Enter to send)`"
        />
        <VibeButton
          variant="primary"
          :disabled="!composerDraft.trim()"
          :title="thread ? 'Reply (Enter) — 60s undo window' : 'Send (Enter) — 60s undo window'"
          @click="submit"
        >
          <VibeIcon icon="send-fill" />
        </VibeButton>
      </div>
    </template>
  </VibeCard>
</template>

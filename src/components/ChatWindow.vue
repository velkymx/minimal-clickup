<script setup lang="ts">
import { computed, nextTick, onUnmounted, reactive, ref, watch } from 'vue'
import type Quill from 'quill'
import {
  VibeButton,
  VibeFormTextarea,
  VibeFormWysiwyg,
  VibeIcon,
  VibeOffcanvas,
  VibeSpinner,
  useToast,
} from '@velkymx/vibeui'
import { useRoute, useRouter } from 'vue-router'
import { useChat } from '../composables/useChat'
import { useMentionSuggest, useTextareaMentions } from '../composables/useMentionSuggest'
import { htmlToMarkdown, htmlToText, markdownToSafeHtml } from '../lib/markdown'
import type { PendingSend } from '../types'
import GiphyPicker from './GiphyPicker.vue'
import MentionMenu from './MentionMenu.vue'
import MessageItem from './MessageItem.vue'

const {
  state,
  activeChannel,
  send,
  undoSend,
  sendNow,
  memberFor,
  openChannel,
  closeChannel,
  openThread,
  closeThread,
  sendThreadReply,
} = useChat()
const toast = useToast()
const route = useRoute()
const router = useRouter()

// URL is the source of truth for the open channel (bookmarkable).
watch(
  () => [route.params.channelId, state.channels.length] as const,
  ([channelId]) => {
    // This page is being left — the route already belongs to another view.
    if (route.path !== '/' && !route.path.startsWith('/channel/')) return
    const id = typeof channelId === 'string' ? channelId : ''
    if (id && state.channels.some((c) => c.id === id)) {
      openChannel(id)
    } else if (state.channels.length) {
      // No/unknown channel in URL — fall back to the last one viewed, else the first.
      const fallback = state.channels.some((c) => c.id === state.lastChannelId)
        ? state.lastChannelId
        : state.channels[0].id
      router.replace(`/channel/${fallback}`)
    }
  },
  { immediate: true },
)

// Off the chat page the open channel isn't on screen — stop marking it read.
onUnmounted(closeChannel)

const draft = ref('') // Quill HTML
const scroller = ref<HTMLElement | null>(null)

const draftIsEmpty = computed(() => !htmlToText(draft.value).trim())

const COMPACT_WINDOW_MS = 5 * 60 * 1000

// Index of the first message that arrived after the channel was last read —
// the "NEW" divider renders above it and stays until you switch channels.
const firstNewIndex = computed(() => {
  if (!state.dividerAt) return -1
  return state.messages.findIndex(
    (m) => m.date > state.dividerAt && m.user_id !== state.me?.id,
  )
})

function isCompact(index: number): boolean {
  const current = state.messages[index]
  const previous = state.messages[index - 1]
  if (!previous || !current.user_id) return false
  return (
    previous.user_id === current.user_id &&
    current.date - previous.date < COMPACT_WINDOW_MS
  )
}

const showJumpToLatest = ref(false)

function scrollToBottom(smooth = false) {
  const el = scroller.value
  if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
}

function onScroll() {
  const el = scroller.value
  if (!el) return
  showJumpToLatest.value =
    el.scrollHeight - el.scrollTop - el.clientHeight > 200
}

// ---------- Pending sends (undo window) ----------

const pendingHere = computed(() =>
  state.pending.filter(
    (p) => p.channelId === state.activeChannelId && !p.threadParentId,
  ),
)

const pendingInThread = computed(() =>
  state.pending.filter(
    (p) => p.threadParentId && p.threadParentId === state.thread?.parent.id,
  ),
)

function secondsLeft(item: PendingSend): number {
  return Math.max(0, Math.ceil((item.sendAt - state.nowTick) / 1000))
}

function undo(item: PendingSend) {
  const restored = undoSend(item.id)
  if (!restored) return
  if (restored.threadParentId) {
    replyDraft.value = restored.draft ?? restored.content
  } else {
    draft.value = restored.draft ?? restored.content
  }
}

async function deliverNow(item: PendingSend) {
  try {
    await sendNow(item.id)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'Failed to send message.')
  }
}

watch(
  () => [state.activeChannelId, state.messages.length + pendingHere.value.length],
  async ([channelId], [prevChannelId]) => {
    const el = scroller.value
    // Stick to bottom on channel switch or when already near the bottom.
    const nearBottom =
      !el || el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (channelId !== prevChannelId || nearBottom) {
      await nextTick()
      scrollToBottom()
    }
  },
)

// ---------- Thread panel ----------

const replyDraft = ref('')
const threadScroller = ref<HTMLElement | null>(null)
const replyComposer = ref<HTMLElement | null>(null)
const replyMention = reactive(useTextareaMentions(replyComposer, replyDraft))

// New replies (or thread open) → scroll the thread to its latest reply.
watch(
  () => [state.thread?.parent.id, state.thread?.replies.length],
  async () => {
    await nextTick()
    const el = threadScroller.value
    if (el) el.scrollTop = el.scrollHeight
  },
)

const threadOpen = computed({
  get: () => state.thread !== null,
  set: (open: boolean) => {
    if (!open) closeThread()
  },
})

function threadCompact(index: number): boolean {
  const replies = state.thread?.replies ?? []
  const current = replies[index]
  const previous = replies[index - 1]
  if (!previous || !current.user_id) return false
  return (
    previous.user_id === current.user_id &&
    current.date - previous.date < COMPACT_WINDOW_MS
  )
}

function submitReply() {
  const text = replyDraft.value
  if (!text.trim()) return
  replyDraft.value = ''
  sendThreadReply(text) // queued — undo window starts
}

function onReplyKeydown(event: KeyboardEvent) {
  if (replyMention.handleKey(event)) return
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    submitReply()
  }
}

function submit() {
  const html = draft.value
  const markdown = htmlToMarkdown(html)
  if (!markdown.trim()) return
  draft.value = ''
  send(markdown, html) // queued — undo window starts
}

// ---------- GIPHY ----------

const showGiphy = ref(false)

function sendGif(url: string, title: string) {
  // Sent as a link — ClickUp's API nulls image-markdown URLs on ingest;
  // our renderer auto-embeds image links (official clients show a link).
  send(`[${title || 'GIF'}](${url})`) // queued — undo window applies
}

// ---------- @mentions in the main editor ----------

let quill: Quill | null = null

const mainMention = reactive(
  useMentionSuggest((member, query) => {
    const selection = quill?.getSelection()
    if (!quill || !selection) return
    const start = Math.max(0, selection.index - query.length - 1)
    quill.deleteText(start, selection.index - start, 'user')
    quill.insertText(start, `@${member.username} `, 'user')
    quill.setSelection(start + member.username.length + 2, 0, 'user')
  }),
)

// VibeFormWysiwyg types its `ready` payload as unknown — it's the Quill instance.
function onEditorReady(editor: unknown) {
  const instance = editor as Quill
  quill = instance
  // Fires on typing and caret moves: track the @query before the caret.
  instance.on('editor-change', () => {
    const selection = instance.getSelection()
    if (selection) mainMention.update(instance.getText(0, selection.index))
    else mainMention.dismiss()
  })
}

// Capture phase so Quill's own Enter handler (newline) never fires for plain
// Enter. Shift+Enter still inserts a newline inside the editor.
function onKeydown(event: KeyboardEvent) {
  if (mainMention.handleKey(event)) return
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    event.stopPropagation()
    submit()
  }
}
</script>

<template>
  <main class="chat-main" :class="{ 'thread-open': threadOpen }">
    <header class="chat-header">
      <template v-if="activeChannel">
        <VibeIcon :icon="activeChannel.type === 'CHANNEL' ? 'hash' : 'person-fill'" class="me-1" />
        <strong>{{ activeChannel.displayName || activeChannel.name }}</strong>
        <span v-if="activeChannel.description" class="text-body-secondary ms-2 text-truncate">
          {{ activeChannel.description }}
        </span>
      </template>
      <span v-else class="text-body-secondary">Pick a channel</span>
    </header>

    <div class="message-scroll-wrap">
    <div ref="scroller" class="message-scroll" @scroll.passive="onScroll">
      <div v-if="state.loadingMessages" class="p-4 text-center">
        <VibeSpinner />
      </div>
      <div
        v-else-if="!state.messages.length && activeChannel"
        class="p-4 text-center text-body-secondary"
      >
        No messages yet. Say hi 👋
      </div>
      <template v-for="(message, index) in state.messages" :key="message.id">
        <div v-if="index === firstNewIndex" class="new-divider" role="separator">
          <span class="new-divider-label">NEW</span>
        </div>
        <MessageItem
          :message="message"
          :member="memberFor(message.user_id)"
          :compact="isCompact(index) && index !== firstNewIndex"
          :mine="message.user_id === state.me?.id"
          :unseen="firstNewIndex !== -1 && index >= firstNewIndex"
          @open-thread="openThread"
        />
      </template>

      <div v-for="item in pendingHere" :key="item.id" class="pending-row">
        <!-- eslint-disable-next-line vue/no-v-html — own content, sanitized -->
        <div class="pending-content" v-html="markdownToSafeHtml(item.content)"></div>
        <div class="pending-controls">
          <span v-if="item.failed" class="text-danger small">Send failed.</span>
          <span v-else class="text-body-secondary small">
            Sending in {{ secondsLeft(item) }}s…
          </span>
          <VibeButton size="sm" variant="secondary" outline @click="undo(item)">
            Undo send
          </VibeButton>
          <VibeButton size="sm" variant="primary" :disabled="item.dispatching" @click="deliverNow(item)">
            {{ item.failed ? 'Retry now' : 'Send now' }}
          </VibeButton>
        </div>
      </div>
    </div>

    <VibeButton
      v-show="showJumpToLatest"
      class="jump-latest"
      variant="primary"
      size="sm"
      @click="scrollToBottom(true)"
    >
      <VibeIcon icon="arrow-down-circle" class="me-1" />
      Scroll to latest messages
    </VibeButton>
    </div>

    <footer class="composer position-relative" @keydown.capture="onKeydown">
      <MentionMenu
        :matches="mainMention.matches"
        :active="mainMention.active"
        @pick="mainMention.pick"
      />
      <VibeFormWysiwyg
        v-model="draft"
        class="composer-input"
        toolbar="full"
        mobile-toolbar="minimal"
        height="90px"
        :placeholder="activeChannel ? `Message ${activeChannel.displayName || activeChannel.name}` : 'Pick a channel first'"
        :disabled="!activeChannel"
        @component-error="(err: { message: string }) => toast.error(err.message)"
        @ready="onEditorReady"
      />
      <div class="composer-buttons">
        <VibeButton
          variant="secondary"
          outline
          :disabled="!activeChannel"
          title="Send a GIF"
          @click="showGiphy = true"
        >
          GIF
        </VibeButton>
        <VibeButton
          variant="primary"
          :disabled="draftIsEmpty || !activeChannel"
          title="Send (Enter) — 60s undo window"
          @click="submit"
        >
          <VibeIcon icon="send-fill" />
        </VibeButton>
      </div>
    </footer>

    <GiphyPicker v-model="showGiphy" @pick="sendGif" />

    <VibeOffcanvas v-model="threadOpen" title="Thread" placement="end" :backdrop="false" scroll>
      <div v-if="state.thread" class="thread-panel">
        <div ref="threadScroller" class="thread-scroll">
          <MessageItem
            :message="state.thread.parent"
            :member="memberFor(state.thread.parent.user_id)"
            :compact="false"
            :mine="state.thread.parent.user_id === state.me?.id"
            in-thread
          />

          <div class="thread-divider text-body-secondary">
            {{ state.thread.replies.length }}
            {{ state.thread.replies.length === 1 ? 'reply' : 'replies' }}
          </div>

          <div v-if="state.thread.loading" class="p-3 text-center">
            <VibeSpinner size="sm" />
          </div>
          <div
            v-else-if="!state.thread.replies.length"
            class="p-3 text-center text-body-secondary"
          >
            No replies yet.
          </div>
          <MessageItem
            v-for="(reply, index) in state.thread.replies"
            :key="reply.id"
            :message="reply"
            :member="memberFor(reply.user_id)"
            :compact="threadCompact(index)"
            :mine="reply.user_id === state.me?.id"
            in-thread
          />

          <div v-for="item in pendingInThread" :key="item.id" class="pending-row">
            <!-- eslint-disable-next-line vue/no-v-html — own content, sanitized -->
            <div class="pending-content" v-html="markdownToSafeHtml(item.content)"></div>
            <div class="pending-controls">
              <span v-if="item.failed" class="text-danger small">Send failed.</span>
              <span v-else class="text-body-secondary small">
                Sending in {{ secondsLeft(item) }}s…
              </span>
              <VibeButton size="sm" variant="secondary" outline @click="undo(item)">
                Undo send
              </VibeButton>
              <VibeButton size="sm" variant="primary" :disabled="item.dispatching" @click="deliverNow(item)">
                {{ item.failed ? 'Retry now' : 'Send now' }}
              </VibeButton>
            </div>
          </div>
        </div><!-- /thread-scroll -->

        <div
          ref="replyComposer"
          class="thread-composer position-relative"
          @keydown="onReplyKeydown"
          @input="replyMention.track"
          @click="replyMention.track"
          @keyup="replyMention.track"
        >
          <MentionMenu
            :matches="replyMention.matches"
            :active="replyMention.active"
            @pick="replyMention.pick"
          />
          <VibeFormTextarea
            v-model="replyDraft"
            :rows="2"
            no-resize
            placeholder="Reply… (Enter to send, @ to mention)"
          />
          <VibeButton
            variant="primary"
            class="mt-2"
            :disabled="!replyDraft.trim()"
            @click="submitReply"
          >
            Reply
          </VibeButton>
        </div>
      </div>
    </VibeOffcanvas>
  </main>
</template>

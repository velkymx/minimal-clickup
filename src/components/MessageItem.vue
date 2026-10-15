<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  VibeButton,
  VibeDropdown,
  VibeIcon,
  useToast,
  type DropdownItem,
} from '@velkymx/vibeui'
import { useChat } from '../composables/useChat'
import { useLightbox } from '../composables/useLightbox'
import { emojiFor, QUICK_REACTIONS } from '../lib/emoji'
import { markdownToSafeHtml } from '../lib/markdown'
import { mentionsUser } from '../lib/mentions'
import type { ChatMessage, Member } from '../types'

const props = defineProps<{
  message: ChatMessage
  member: Member
  /** Consecutive message from same author within a few minutes → compact row. */
  compact: boolean
  mine: boolean
  /** Arrived after the channel was last read — gets the unread accent. */
  unseen?: boolean
  /** Rendered inside a thread — hides the reply affordances. */
  inThread?: boolean
}>()

/** The host (chat page or docked box) decides where the thread opens. */
const emit = defineEmits<{ 'open-thread': [message: ChatMessage] }>()

const { state, toggleReaction } = useChat()
const { openLightbox } = useLightbox()
const toast = useToast()

/** v-html content — delegate clicks so images open the lightbox. */
function onContentClick(event: MouseEvent) {
  const target = event.target as HTMLElement
  if (target.tagName === 'IMG') {
    const img = target as HTMLImageElement
    openLightbox(img.src, img.alt)
  }
}

const reacting = ref(false)

const time = computed(() =>
  new Date(props.message.date).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  }),
)

const fullDate = computed(() => new Date(props.message.date).toLocaleString())

const renderedContent = computed(() =>
  markdownToSafeHtml(props.message.content ?? '', state.me?.id),
)

const mentionsMe = computed(() => mentionsUser(props.message.content, state.me?.id))

// Attachment-only messages (images/GIFs/files uploaded in the official app)
// arrive with empty content — the public API doesn't expose attachments.
const isAttachmentOnly = computed(() => !(props.message.content ?? '').trim())

const reactionSummary = computed(() => {
  const byName = new Map<string, { count: number; mine: boolean }>()
  for (const r of props.message.reactions ?? []) {
    const entry = byName.get(r.reaction) ?? { count: 0, mine: false }
    entry.count++
    // reactions endpoint sends user_id as a number; messages as a string
    if (String(r.user_id) === state.me?.id) entry.mine = true
    byName.set(r.reaction, entry)
  }
  return [...byName.entries()].map(([name, { count, mine }]) => ({
    name,
    count,
    mine,
  }))
})

const pickerItems: DropdownItem[] = QUICK_REACTIONS.map((name) => ({
  text: name,
}))

async function react(name: string) {
  if (reacting.value) return
  reacting.value = true
  try {
    await toggleReaction(props.message, name)
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'Reaction failed.')
  } finally {
    reacting.value = false
  }
}

function onPick({ item }: { item: DropdownItem }) {
  if (item.text) react(item.text)
}

async function copyMessage() {
  try {
    await navigator.clipboard.writeText(props.message.content ?? '')
    toast.success('Copied to clipboard')
  } catch {
    toast.error('Copy failed — clipboard unavailable.')
  }
}
</script>

<template>
  <div class="message-row" :class="{ compact, unseen, 'bg-warning-subtle': mentionsMe }">
    <template v-if="!compact">
      <img
        v-if="member.profilePicture"
        class="avatar"
        :src="member.profilePicture"
        :alt="member.username"
      />
      <div
        v-else
        class="avatar avatar-initials"
        :style="{ backgroundColor: member.color }"
      >
        {{ member.initials }}
      </div>
    </template>
    <div v-else class="avatar-spacer" :title="fullDate"></div>

    <div class="message-body">
      <div v-if="!compact" class="message-meta">
        <span class="message-author" :class="{ 'text-primary': mine }">
          {{ member.username }}
        </span>
        <span class="message-time text-body-secondary" :title="fullDate">{{ time }}</span>
      </div>
      <div v-if="isAttachmentOnly" class="attachment-placeholder text-body-secondary">
        <VibeIcon icon="paperclip" class="me-1" />
        Attachment — not available via ClickUp's API; view in the ClickUp app
      </div>
      <!-- eslint-disable-next-line vue/no-v-html — sanitized above -->
      <div v-else class="message-content" v-html="renderedContent" @click="onContentClick"></div>

      <div v-if="reactionSummary.length || message.replies_count" class="message-extras">
        <button
          v-for="entry in reactionSummary"
          :key="entry.name"
          type="button"
          class="reaction-chip"
          :class="{ mine: entry.mine }"
          :disabled="reacting"
          :title="entry.mine ? 'Remove your reaction' : 'React'"
          @click="react(entry.name)"
        >
          {{ emojiFor(entry.name) }} {{ entry.count }}
        </button>
        <button
          v-if="message.replies_count && !inThread"
          type="button"
          class="reaction-chip replies-chip"
          title="Open thread"
          @click="emit('open-thread', message)"
        >
          <VibeIcon icon="chat-text" class="me-1" />{{ message.replies_count }}
          {{ message.replies_count === 1 ? 'reply' : 'replies' }}
        </button>
      </div>

      <div class="message-actions">
        <VibeButton
          variant="secondary"
          outline
          size="sm"
          title="Copy message"
          @click="copyMessage"
        >
          <VibeIcon icon="clipboard" />
        </VibeButton>
        <VibeButton
          v-if="!inThread"
          variant="secondary"
          outline
          size="sm"
          title="Reply in thread"
          @click="emit('open-thread', message)"
        >
          <VibeIcon icon="chat-text" />
        </VibeButton>
        <VibeDropdown
          class="reaction-picker"
          variant="secondary"
          size="sm"
          direction="up"
          :items="pickerItems"
          @item-click="onPick"
        >
          <template #button>
            <VibeIcon icon="emoji-smile" />
          </template>
          <template #item="{ item }">
            <span class="reaction-option" :title="item.text">{{ emojiFor(item.text ?? '') }}</span>
          </template>
        </VibeDropdown>
      </div>
    </div>
  </div>
</template>

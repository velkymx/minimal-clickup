import { computed, nextTick, ref, type Ref } from 'vue'
import { insertMention, mentionQuery } from '../lib/mentions'
import type { Member } from '../types'
import { useChat } from './useChat'

const MAX_SUGGESTIONS = 6

/** Keys that move the caret without typing — re-check the @query on these. */
const CARET_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End'])

/**
 * @-mention autocomplete for one composer. The composer reports the text
 * before the caret via `update`; `apply` inserts the picked member.
 */
export function useMentionSuggest(apply: (member: Member, query: string) => void) {
  const { state } = useChat()
  const query = ref<string | null>(null)
  const active = ref(0)

  const matches = computed<Member[]>(() => {
    if (query.value === null) return []
    const q = query.value.toLowerCase()
    return [...state.members.values()]
      // Match the start of any name word: "@kot" finds "Halee Kotara".
      .filter(
        (m) =>
          m.id !== state.me?.id &&
          m.username.toLowerCase().split(/\s+/).some((word) => word.startsWith(q)),
      )
      .sort((a, b) => a.username.localeCompare(b.username))
      .slice(0, MAX_SUGGESTIONS)
  })

  function update(textBeforeCaret: string) {
    const next = mentionQuery(textBeforeCaret)
    if (next !== query.value) active.value = 0
    query.value = next
  }

  function dismiss() {
    query.value = null
  }

  function pick(member: Member) {
    const typed = query.value ?? ''
    query.value = null
    apply(member, typed)
  }

  /** Arrow / Enter / Tab / Escape while the menu is open. True when consumed. */
  function handleKey(event: KeyboardEvent): boolean {
    const count = matches.value.length
    if (!count) return false
    switch (event.key) {
      case 'ArrowDown':
        active.value = (active.value + 1) % count
        break
      case 'ArrowUp':
        active.value = (active.value - 1 + count) % count
        break
      case 'Enter':
      case 'Tab':
        pick(matches.value[active.value])
        break
      case 'Escape':
        dismiss()
        break
      default:
        return false
    }
    event.preventDefault()
    event.stopPropagation()
    return true
  }

  return { matches, active, update, dismiss, pick, handleKey }
}

/**
 * Mention autocomplete wired to a plain-text composer. `wrapper` contains the
 * <textarea>; bind `track` to its input, click and keyup events.
 */
export function useTextareaMentions(wrapper: Ref<HTMLElement | null>, draft: Ref<string>) {
  const textarea = () => wrapper.value?.querySelector('textarea') ?? null

  const suggest = useMentionSuggest((member, query) => {
    const el = textarea()
    if (!el) return
    const next = insertMention(draft.value, el.selectionStart, query, member.username)
    draft.value = next.text
    nextTick(() => {
      el.focus()
      el.setSelectionRange(next.caret, next.caret)
    })
  })

  function track(event: Event) {
    if (event instanceof KeyboardEvent && !CARET_KEYS.has(event.key)) return
    const el = textarea()
    if (el) suggest.update(el.value.slice(0, el.selectionStart))
  }

  return { ...suggest, track }
}

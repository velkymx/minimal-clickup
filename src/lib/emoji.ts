/**
 * ClickUp reactions are lowercase emoji names (e.g. "thumbsup").
 * Map the common ones to glyphs; unknown names render as :name:.
 */
const EMOJI: Record<string, string> = {
  thumbsup: '👍',
  thumbs_up: '👍',
  '+1': '👍',
  thumbsdown: '👎',
  thumbs_down: '👎',
  '-1': '👎',
  heart: '❤️',
  heart_eyes: '😍',
  joy: '😂',
  grinning: '😀',
  smile: '😄',
  laughing: '😆',
  sweat_smile: '😅',
  wink: '😉',
  sunglasses: '😎',
  thinking_face: '🤔',
  scream: '😱',
  cry: '😢',
  sob: '😭',
  angry: '😠',
  rage: '😡',
  partying_face: '🥳',
  tada: '🎉',
  fire: '🔥',
  eyes: '👀',
  clap: '👏',
  pray: '🙏',
  raised_hands: '🙌',
  ok_hand: '👌',
  wave: '👋',
  muscle: '💪',
  rocket: '🚀',
  star: '⭐',
  bulb: '💡',
  white_check_mark: '✅',
  heavy_check_mark: '✔️',
  x: '❌',
  warning: '⚠️',
  question: '❓',
  exclamation: '❗',
  100: '💯',
}

/**
 * Names offered in the reaction picker, in display order.
 * ClickUp uses Slack-style shortnames: thumbs up/down are '+1'/'-1'
 * (every name below verified accepted by the live API).
 */
export const QUICK_REACTIONS = [
  '+1',
  '-1',
  'heart',
  'joy',
  'tada',
  'fire',
  'eyes',
  'white_check_mark',
  'clap',
  'pray',
  'rocket',
  'thinking_face',
  'sob',
  'partying_face',
  '100',
  'wave',
]

export function emojiFor(name: string): string {
  return EMOJI[name] ?? `:${name}:`
}

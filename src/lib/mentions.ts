import type { Member } from '../types'

/**
 * ClickUp chat mention markup, as returned by the v3 API (and written by the
 * official clients): `[@Display Name](#user_mention#12345)`.
 *
 * Messages sent through the public API with this markup render as mentions
 * but (per ClickUp's feedback board) don't yet notify — native API mention
 * support is "planned" on their side.
 */
const MENTION_HREF_PREFIX = '#user_mention#'

/** User id from a mention link href, or null for any other href. */
export function mentionUserId(href: string): string | null {
  return href.startsWith(MENTION_HREF_PREFIX)
    ? href.slice(MENTION_HREF_PREFIX.length) || null
    : null
}

/** True when the message content mentions `userId`. */
export function mentionsUser(content: string | undefined, userId: string | undefined): boolean {
  return !!content && !!userId && content.includes(`](${MENTION_HREF_PREFIX}${userId})`)
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Turn typed `@Full Name` into ClickUp mention markup for every known member.
 * Longest names win (`@Ann Lee` before `@Ann`); existing `[@…](…)` links are
 * left alone.
 */
export function linkMentions(markdown: string, members: Iterable<Member>): string {
  const byName = new Map<string, Member>()
  for (const member of members) byName.set(member.username.toLowerCase(), member)
  if (!byName.size || !markdown.includes('@')) return markdown
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map(escapeRegex)
  const pattern = new RegExp(`(?<![\\[\\w])@(${names.join('|')})(?![\\w])`, 'gi')
  return markdown.replace(pattern, (match, name: string) => {
    const member = byName.get(name.toLowerCase())
    return member ? `[@${member.username}](${MENTION_HREF_PREFIX}${member.id})` : match
  })
}

/** Replace the `@query` ending at `caret` with `@Full Name `. */
export function insertMention(
  text: string,
  caret: number,
  query: string,
  name: string,
): { text: string; caret: number } {
  const token = `@${query}`
  const start = text.slice(0, caret).endsWith(token) ? caret - token.length : caret
  const inserted = `@${name} `
  return {
    text: text.slice(0, start) + inserted + text.slice(caret),
    caret: start + inserted.length,
  }
}

/** The `@query` being typed right before the caret, or null when not mentioning. */
export function mentionQuery(textBeforeCaret: string): string | null {
  const match = /(?:^|\s)@([^\s@]{0,30})$/.exec(textBeforeCaret)
  return match ? match[1] : null
}

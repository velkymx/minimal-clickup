import DOMPurify from 'dompurify'
import { marked } from 'marked'

// Chat links should open outside the app.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

const IMAGE_URL_RE = /\.(gif|png|jpe?g|webp)(\?[^\s]*)?$/i

/**
 * Render ClickUp message markdown to HTML safe for v-html.
 * Message content is other users' input — always sanitize.
 *
 * Two ClickUp-specific transforms:
 * - The API rewrites image markdown to `![alt](http://null)` on ingest
 *   (attachments aren't exposed publicly) — show a placeholder instead of a
 *   broken image.
 * - Because of that, this app sends images as plain LINKS; any link whose
 *   URL looks like an image is auto-embedded as an inline image here.
 */
export function markdownToSafeHtml(markdown: string): string {
  const cleaned = markdown.replace(
    /!\[([^\]]*)\]\(http:\/\/null\)/g,
    (_, alt: string) => `*📎 ${alt || 'attachment'} — view in ClickUp*`,
  )
  const html = marked.parse(cleaned, { async: false, gfm: true, breaks: true })
  const safe = DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] })

  const doc = new DOMParser().parseFromString(safe, 'text/html')
  for (const anchor of Array.from(doc.body.querySelectorAll('a'))) {
    const href = anchor.getAttribute('href') ?? ''
    if (/^https?:\/\//i.test(href) && IMAGE_URL_RE.test(href)) {
      const img = doc.createElement('img')
      img.setAttribute('src', href)
      img.setAttribute('alt', anchor.textContent || 'image')
      img.setAttribute('loading', 'lazy')
      anchor.replaceWith(img)
    }
  }
  return doc.body.innerHTML
}

/**
 * Convert Quill's (sanitized) HTML output to markdown for ClickUp's
 * `content_format: 'text/md'`. Handles the tags Quill's toolbar can produce;
 * anything unknown falls back to its text content.
 */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return blocks(doc.body).replace(/\n{3,}/g, '\n\n').trim()
}

/** Plain text of an HTML string — used for "is the draft empty?" checks. */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return doc.body.textContent ?? ''
}

function blocks(root: Element): string {
  let out = ''
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent
      continue
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue
    const el = node as Element
    const tag = el.tagName.toLowerCase()
    switch (tag) {
      case 'p':
      case 'div':
        out += `${inline(el)}\n\n`
        break
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        out += `${'#'.repeat(Number(tag[1]))} ${inline(el)}\n\n`
        break
      case 'ul':
      case 'ol':
        out += `${list(el, tag === 'ol')}\n`
        break
      case 'blockquote':
        out += `> ${inline(el)}\n\n`
        break
      case 'pre':
        out += `\`\`\`\n${el.textContent ?? ''}\n\`\`\`\n\n`
        break
      case 'br':
        out += '\n'
        break
      default:
        out += inline(el)
    }
  }
  return out
}

function list(el: Element, ordered: boolean): string {
  let out = ''
  let n = 1
  for (const li of Array.from(el.children)) {
    if (li.tagName.toLowerCase() !== 'li') continue
    out += `${ordered ? `${n}.` : '-'} ${inline(li)}\n`
    n++
  }
  return out
}

function inline(el: Node): string {
  let out = ''
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent
      continue
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue
    const child = node as Element
    const inner = inline(child)
    switch (child.tagName.toLowerCase()) {
      case 'strong':
      case 'b':
        out += inner && `**${inner}**`
        break
      case 'em':
      case 'i':
        out += inner && `*${inner}*`
        break
      case 's':
      case 'strike':
      case 'del':
        out += inner && `~~${inner}~~`
        break
      case 'code':
        out += inner && `\`${inner}\``
        break
      case 'a': {
        const href = child.getAttribute('href') ?? ''
        out += href ? `[${inner || href}](${href})` : inner
        break
      }
      case 'img': {
        const src = child.getAttribute('src') ?? ''
        // Pasted images arrive as data: URIs — megabytes of base64, and
        // ClickUp caps content at 40k chars. Only URL images survive.
        // Sent as a LINK, not image markdown: ClickUp's API nulls image
        // markdown URLs on ingest. markdownToSafeHtml re-embeds image links.
        if (src && !src.startsWith('data:')) {
          out += `[${child.getAttribute('alt') || 'image'}](${src})`
        }
        break
      }
      case 'br':
        out += '\n'
        break
      case 'u': // markdown has no underline — keep text
      case 'span':
      default:
        out += inner
    }
  }
  return out
}

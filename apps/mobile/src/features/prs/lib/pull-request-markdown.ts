// Adapted from T3 Code packages/client-runtime/src/pullRequestMarkdown.ts and apps/mobile/src/features/pull-requests/pullRequestDescriptionContent.ts (MIT, see UPSTREAM.md).
import { isBotBadgeImage } from './bot-badge-images'

/**
 * The media of a pull request body. A standalone media link or a `<video>`
 * tag becomes an attachment of its own; ordinary links and code examples stay
 * Markdown. The description lists every image and video once, in an
 * Attachments strip, without the badges that bots stamp into a body.
 *
 * T3 reads the images from a parsed Markdown tree (remark). The phone has no
 * Markdown parser in JavaScript, so the images come from a line scan that
 * skips code fences, indented code, inline code, and HTML comments.
 */

/** `id` is positional: the same attachment can be in one body two times. */
export type PullRequestBodySegment =
  | { readonly id: string; readonly kind: 'markdown'; readonly text: string }
  | { readonly id: string; readonly kind: 'attachment'; readonly url: string; readonly media: AttachmentMedia }

/** A bare GitHub upload link on its own line is a video: GitHub writes a dropped image as an `<img>` tag. */
export type AttachmentMedia = 'video' | 'image' | 'unknown'

export interface PullRequestAttachment {
  readonly uri: string
  readonly caption: string
  readonly kind: AttachmentMedia
}

const FENCE_PATTERN = /^\s{0,3}((?:`{3,})|(?:~{3,}))(.*)$/u
/** How far a `<video>` tag may reach for its closing tag. */
const VIDEO_TAG_MAX_LINES = 8
/** Four spaces open an indented code block. */
const INDENTED_CODE_PATTERN = /^(?: {4}|\t)/u
const BARE_URL_PATTERN = /^<?(https?:\/\/\S+?)>?$/u
const IMAGE_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp|avif|heic|heif|svg)(?:$|[?#])/iu
const MARKDOWN_LINK_PATTERN = /^\[[^\]]*\]\((https?:\/\/[^\s)]+)\)$/u
const VIDEO_EXTENSION_PATTERN = /\.(?:mp4|webm|mov|m4v|ogv)(?:$|[?#])/iu
const GITHUB_ASSET_PATTERN = /^https:\/\/github\.com\/user-attachments\/assets\/[\w-]+$/iu
const VIDEO_TAG_SRC_PATTERN = /<(?:video|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/iu
const STANDALONE_VIDEO_TAG_PATTERN = /^\s*<video\b/iu
const VIDEO_TAG_END_PATTERN = /<\/video>\s*$/iu
const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+["']([^"']*)["'])?\s*\)/gu
const HTML_IMAGE_PATTERN = /<img\b[^>]*>/giu
const INLINE_CODE_PATTERN = /(`+)[\s\S]*?\1/gu
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/gu

/** Only a web address is an upload; `javascript:`, `data:`, and a relative path are not. */
function isWebUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function attachmentFromLine(line: string): { url: string; media: AttachmentMedia } | null {
  const url = BARE_URL_PATTERN.exec(line.trim())?.[1] ?? MARKDOWN_LINK_PATTERN.exec(line.trim())?.[1]
  if (url === undefined || !isWebUrl(url)) return null
  if (VIDEO_EXTENSION_PATTERN.test(url) || GITHUB_ASSET_PATTERN.test(url)) return { url, media: 'video' }
  if (IMAGE_EXTENSION_PATTERN.test(url)) return { url, media: 'image' }
  return null
}

/** Each line of `body` with whether it is code, as a fence or indentation makes it. */
function classifyLines(body: string): { line: string; code: boolean }[] {
  let openFence: string | null = null
  return body.split('\n').map((line) => {
    const fenceMatch = FENCE_PATTERN.exec(line)
    if (fenceMatch !== null) {
      const fence = fenceMatch[1]!
      // A fence closes only on the same marker, at least as long, with nothing after it.
      const closes = openFence !== null && fence[0] === openFence[0] && fence.length >= openFence.length && fenceMatch[2]!.trim().length === 0
      if (openFence === null) openFence = fence
      else if (closes) openFence = null
      return { line, code: true }
    }
    return { line, code: openFence !== null || INDENTED_CODE_PATTERN.test(line) }
  })
}

/** Lifts standalone media links and `<video>` tags out of the prose. */
export function splitPullRequestBody(body: string): PullRequestBodySegment[] {
  const segments: PullRequestBodySegment[] = []
  const markdown: string[] = []
  // Blank lines around a run go; leading spaces stay, because four of them are code.
  const flushMarkdown = () => {
    const text = markdown.join('\n').replace(/^\n+/u, '').replace(/\s+$/u, '')
    markdown.length = 0
    if (text.trim().length > 0) segments.push({ id: `markdown:${segments.length}`, kind: 'markdown', text })
  }
  const lines = classifyLines(body)
  for (let index = 0; index < lines.length; index += 1) {
    const { line, code } = lines[index]!
    if (code) {
      markdown.push(line)
      continue
    }
    const bare = attachmentFromLine(line)
    if (bare !== null) {
      flushMarkdown()
      segments.push({ id: `attachment:${segments.length}`, kind: 'attachment', ...bare })
      continue
    }
    if (!STANDALONE_VIDEO_TAG_PATTERN.test(line)) {
      markdown.push(line)
      continue
    }
    // A tag can span lines: look ahead for its close, within a bound.
    const lastCandidate = Math.min(index + VIDEO_TAG_MAX_LINES, lines.length) - 1
    let cursor = index
    while (cursor < lastCandidate && !VIDEO_TAG_END_PATTERN.test(lines[cursor]!.line)) cursor += 1
    const source = VIDEO_TAG_END_PATTERN.test(lines[cursor]!.line)
      ? VIDEO_TAG_SRC_PATTERN.exec(lines.slice(index, cursor + 1).map((entry) => entry.line).join('\n'))?.[1]
      : undefined
    if (source !== undefined && isWebUrl(source)) {
      flushMarkdown()
      // The author wrote the tag, so it is a video whatever the address looks like.
      segments.push({ id: `attachment:${segments.length}`, kind: 'attachment', url: source, media: 'video' })
      index = cursor
    } else {
      markdown.push(line)
    }
  }
  flushMarkdown()
  return segments
}

function htmlAttribute(tag: string, name: string): string | null {
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    if (match[1]?.toLowerCase() === name) return match[2] ?? match[3] ?? match[4] ?? ''
  }
  return null
}

function fileName(url: string): string {
  return new URL(url).pathname.split('/').pop() ?? ''
}

/**
 * The images and videos of a description, each once: embedded images first
 * (`![alt](url)` and `<img>`), then the standalone media links. Code
 * examples, comments, and local paths give no attachment. Bot badges are
 * left out of the list; the Markdown still draws them in place.
 */
export function pullRequestAttachments(body: string): PullRequestAttachment[] {
  const attachments = new Map<string, PullRequestAttachment>()
  const add = (uri: string, caption: string, kind: AttachmentMedia) => {
    if (!isWebUrl(uri) || attachments.has(uri)) return
    attachments.set(uri, { uri, caption, kind })
  }
  for (const { line, code } of classifyLines(body.replace(HTML_COMMENT_PATTERN, ''))) {
    if (code) continue
    const prose = line.replace(INLINE_CODE_PATTERN, '')
    for (const match of prose.matchAll(MARKDOWN_IMAGE_PATTERN)) add(match[2]!, match[1] || match[3] || 'Image', 'image')
    for (const match of prose.matchAll(HTML_IMAGE_PATTERN)) {
      const src = htmlAttribute(match[0], 'src')
      if (src) add(src, htmlAttribute(match[0], 'alt') || 'Image', 'image')
    }
  }
  for (const segment of splitPullRequestBody(body)) {
    if (segment.kind !== 'attachment') continue
    add(segment.url, segment.media === 'video' ? 'Video' : fileName(segment.url) || 'Image', segment.media)
  }
  return Array.from(attachments.values()).filter((attachment) => !isBotBadgeImage(attachment.uri))
}

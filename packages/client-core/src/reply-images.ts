import type { Root, RootContent } from 'mdast'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import { hostPathBaseName } from '@solus/contracts/host-path'
import { mediaTypeFor } from '@solus/contracts/media-types'

export interface ReplyImage {
  href: string
  label: string
  format: string
}

const parser = unified().use(remarkParse)

export function replyImage(href: string, alt = ''): ReplyImage {
  const dataFormat = /^data:image\/([^;,]+)/i.exec(href)?.[1]
  if (dataFormat) return { href, label: alt || 'Image', format: dataFormat.toUpperCase() }
  const path = href.split(/[?#]/, 1)[0]
  let name = hostPathBaseName(path)
  try { name = decodeURIComponent(name) } catch {}
  return { href, label: name || alt || 'Image', format: mediaTypeFor(path)?.mime.split('/')[1]?.toUpperCase() ?? 'IMAGE' }
}

interface ImageReference {
  image: ReplyImage
  start: number
  end: number
  isEmbed: boolean
}

/** Positions let mobile replace image embeds without touching matching code examples. */
function imageReferences(markdown: string): ImageReference[] {
  if (!markdown.includes('![') && !/\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)\b/i.test(markdown)) return []
  const root = parser.parse(markdown)
  const definitions = new Map<string, string>()
  const visit = (node: Root | RootContent, fn: (node: Root | RootContent) => void) => {
    fn(node)
    if ('children' in node) for (const child of node.children) visit(child, fn)
  }
  visit(root, (node) => {
    if (node.type === 'definition') definitions.set(node.identifier, node.url)
  })
  const images: ImageReference[] = []
  visit(root, (node) => {
    collectSpacedImages(node, markdown, images)
    const reference = imageReference(node, definitions)
    if (!reference) return
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) return
    images.push({ image: replyImage(reference.href, reference.alt), start, end, isEmbed: node.type === 'image' || node.type === 'imageReference' })
  })
  return images
}

/** The gallery reads references while the assistant text keeps its own presentation. */
export function replyImages(markdown: string): ReplyImage[] {
  const seen = new Set<string>()
  return imageReferences(markdown).flatMap(({ image }) => {
    if (seen.has(image.href)) return []
    seen.add(image.href)
    return [image]
  })
}

/** Native Markdown draws ordinary file links as chips, including in lists and tables. */
export function imageFileChips(markdown: string): string {
  if (!markdown.includes('![')) return markdown
  const images = imageReferences(markdown).filter((reference) => reference.isEmbed)
  for (const { image, start, end } of images.reverse()) {
    const label = image.label.replace(/[\\[\]]/g, '\\$&')
    const href = image.href.replace(/</g, '%3C').replace(/>/g, '%3E').replace(/\n/g, '')
    markdown = markdown.slice(0, start) + `[${label}](<${href}>)` + markdown.slice(end)
  }
  return markdown
}

function imageReference(node: Root | RootContent, definitions: ReadonlyMap<string, string>): { href: string; alt: string } | null {
  let href: string | undefined
  if (node.type === 'image' || node.type === 'link') href = node.url
  else if (node.type === 'imageReference' || node.type === 'linkReference') href = definitions.get(node.identifier)
  if (!href) return null
  const kind = mediaTypeFor(href.split(/[?#]/, 1)[0])?.kind
  const embed = node.type === 'image' || node.type === 'imageReference'
  if (kind === 'video' || (!embed && kind !== 'image')) return null
  return { href, alt: 'alt' in node ? node.alt ?? '' : '' }
}

function collectSpacedImages(node: Root | RootContent, markdown: string, images: ImageReference[]): void {
  if (node.type !== 'text') return
  const offset = node.position?.start.offset
  if (offset === undefined) return
  const raw = markdown.slice(offset, node.position?.end.offset)
  for (const match of raw.matchAll(/!\[([^\]\n]*)\]\(((?:\/|file:)[^\n()]*?)(?:\s+"([^"\n]*)")?\)/g)) {
    const href = match[2].trim()
    if (mediaTypeFor(href)?.kind === 'video') continue
    images.push({ image: replyImage(href, match[1]), start: offset + match.index, end: offset + match.index + match[0].length, isEmbed: true })
  }
}

type ReplyImageMessage = { content: string } | { text: string }
const cache = new WeakMap<ReplyImageMessage, { source: string; result: ReplyImage[] }>()

/** Cache per message, including the current source while a Svelte message mutates. */
export function messageReplyImages(message: ReplyImageMessage): ReplyImage[] {
  const source = 'content' in message ? message.content : message.text
  const prior = cache.get(message)
  if (prior?.source === source) return prior.result
  const result = replyImages(source)
  cache.set(message, { source, result })
  return result
}

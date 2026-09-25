import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import { visit } from 'unist-util-visit'
import { find, html } from 'property-information'
import type { Root as MarkdownRoot } from 'mdast'
import type { Element, Root, RootContent } from 'hast'
import { standaloneLocalVideoHref, standaloneMarkdownMediaLink } from '../../../lib/githubMarkdown'
import { isInlineTaskImageUrl } from '../../tasks/task-page/lib/task-image'

export type MarkdownPolicy = 'remote' | 'local'
export type AlertKind = 'note' | 'tip' | 'important' | 'warning' | 'caution'

function githubAlerts() {
  return (tree: MarkdownRoot) => {
    visit(tree, 'blockquote', (node) => {
      const paragraph = node.children[0]
      if (paragraph?.type !== 'paragraph') return
      const first = paragraph.children[0]
      if (first?.type !== 'text') return
      const marker = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\r?\n|$)/i.exec(first.value)
      if (!marker || (!marker[0].endsWith('\n') && paragraph.children.length > 1)) return
      first.value = first.value.slice(marker[0].length)
      if (!first.value) paragraph.children.shift()
      if (!paragraph.children.length) node.children.shift()
      node.data = { ...node.data, hProperties: { dataAlert: marker[1].toLowerCase() } }
    })
  }
}

function processor(policy: MarkdownPolicy) {
  const protocols = policy === 'local'
    ? {
        ...defaultSchema.protocols,
        href: [...(defaultSchema.protocols?.href ?? []), 'plan', 'work', 'pr', 'session', 'task', 'file', 'asset'],
        src: [...(defaultSchema.protocols?.src ?? []), 'asset', 'file', 'data'],
      }
    : defaultSchema.protocols
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(githubAlerts)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, {
      ...defaultSchema,
      protocols,
      attributes: {
        ...defaultSchema.attributes,
        blockquote: [...(defaultSchema.attributes?.blockquote ?? []), ['dataAlert', 'note', 'tip', 'important', 'warning', 'caution']],
      },
    })
}

const processors = { remote: processor('remote'), local: processor('local') }

/** Parse complete documents once. Never use this full-document path for streaming turns. */
export function parseGithubMarkdown(source: string, policy: MarkdownPolicy = 'remote'): Root {
  const parser = processors[policy]
  const tree = parser.runSync(parser.parse(source))
  visit(tree, 'element', (node) => {
    const src = node.properties.src
    if (typeof src === 'string' && /^\s*data:/i.test(src) && !isInlineTaskImageUrl(src)) {
      delete node.properties.src
    }
  })
  if (policy === 'remote') markMentions(tree)
  return tree
}

/** A code-host login after `@`, as GitHub reads one: not inside a word (so an
 *  email address stays text), up to 39 letters, digits and inner hyphens, and
 *  an optional `/team` for an organisation team mention. */
const MENTION = /(^|[^\w@/`])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?(?:\/[\w.-]+)?)(?![\w@])/g

/** Places where `@name` is literal text, not a mention. */
const MENTION_OPAQUE = new Set(['a', 'code', 'pre', 'kbd', 'script', 'style'])

/**
 * Wraps each `@login` in code-host text in a `.markdown-mention` span, the way
 * GitHub sets a mention apart from the sentence around it. A span, not a link:
 * the host may be GitHub or GitLab, and the renderer does not know which
 * profile URL is right. Runs after sanitizing, so the class is ours.
 */
function markMentions(parent: Root | Element): void {
  for (let index = 0; index < parent.children.length; index++) {
    const child = parent.children[index]
    if (child.type === 'element') {
      if (!MENTION_OPAQUE.has(child.tagName)) markMentions(child)
      continue
    }
    if (child.type !== 'text' || !child.value.includes('@')) continue
    const parts: RootContent[] = []
    let last = 0
    for (const match of child.value.matchAll(MENTION)) {
      const start = match.index + match[1].length
      if (start > last) parts.push({ type: 'text', value: child.value.slice(last, start) })
      parts.push({
        type: 'element',
        tagName: 'span',
        properties: { className: ['markdown-mention'] },
        children: [{ type: 'text', value: `@${match[2]}` }],
      })
      last = start + 1 + match[2].length
    }
    if (parts.length === 0) continue
    if (last < child.value.length) parts.push({ type: 'text', value: child.value.slice(last) })
    parent.children.splice(index, 1, ...(parts as typeof parent.children))
    index += parts.length - 1
  }
}

/** HAST uses DOM property names; Svelte dynamic elements need HTML attribute names. */
export function elementAttributes(node: Element): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {}
  for (const [name, value] of Object.entries(node.properties)) {
    if (value === null || value === undefined) continue
    const info = find(html, name)
    attributes[info.attribute] = Array.isArray(value) ? value.join(info.commaSeparated ? ', ' : ' ') : value
  }
  return attributes
}

export function alertKind(node: Element): AlertKind | null {
  const value = node.properties.dataAlert
  return node.tagName === 'blockquote' && (value === 'note' || value === 'tip' || value === 'important' || value === 'warning' || value === 'caution') ? value : null
}

export function nodeText(node: RootContent): string {
  if (node.type === 'text') return node.value
  return node.type === 'element' ? node.children.map(nodeText).join('') : ''
}

export function paragraphMediaSource(node: Element): string {
  if (node.tagName !== 'p' || node.children.length !== 1) return ''
  const child = node.children[0]
  const href = child.type === 'element' && child.tagName === 'img'
    ? child.properties.src
    : child.type === 'element' && child.tagName === 'a' && nodeText(child) === child.properties.href
      ? child.properties.href : null
  return typeof href === 'string' && standaloneMarkdownMediaLink(href) ? href : ''
}

/** A paragraph that is only a host video written as text, for a local
 *  document. An image-syntax video already reaches the image renderer. */
export function paragraphLocalVideoSource(node: Element): string {
  if (node.tagName !== 'p' || node.children.length !== 1) return ''
  const child = node.children[0]
  return child.type === 'text' ? standaloneLocalVideoHref(child.value) ?? '' : ''
}

/** The text of a ```mermaid fence, which GitHub draws as a diagram. The
 *  sanitizer keeps the `language-*` class, so the fence still names itself. */
export function mermaidFenceSource(node: Element): string | null {
  if (node.tagName !== 'pre' || node.children.length !== 1) return null
  const code = node.children[0]
  if (code.type !== 'element' || code.tagName !== 'code') return null
  const classes = code.properties.className
  return Array.isArray(classes) && classes.includes('language-mermaid') ? nodeText(code) : null
}

export function taskCheckbox(node: Element): Element | undefined {
  if (node.tagName !== 'li') return
  const first = node.children[0]
  const candidate = first?.type === 'element' && first.tagName === 'p' ? first.children[0] : first
  return candidate?.type === 'element' && candidate.tagName === 'input' && candidate.properties.type === 'checkbox' ? candidate : undefined
}

export const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

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
import { standaloneMarkdownMediaLink } from '../../../lib/githubMarkdown'
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
  return tree
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

export function taskCheckbox(node: Element): Element | undefined {
  if (node.tagName !== 'li') return
  const first = node.children[0]
  const candidate = first?.type === 'element' && first.tagName === 'p' ? first.children[0] : first
  return candidate?.type === 'element' && candidate.tagName === 'input' && candidate.properties.type === 'checkbox' ? candidate : undefined
}

export const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

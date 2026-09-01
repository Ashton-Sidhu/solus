/**
 * Markdown ↔ Atlassian Document Format.
 *
 * Jira Cloud's REST v3 will not take a string for a description or a comment;
 * every body is an ADF document. Solus stores markdown everywhere, so the
 * conversion lives here — adapter-private, exactly like Confluence's storage
 * XHTML — and nothing outside this file knows ADF exists.
 *
 * The conversion is deliberately narrow: the block and inline shapes Solus
 * actually writes. An ADF node this file has no markdown for renders as its own
 * text, which reads as a plain paragraph rather than disappearing. That is the
 * honest failure: lossy, never silent corruption, because a pull writes a new
 * local version the user can revert.
 */

import { z } from 'zod'

export interface AdfMark {
  type: string
  attrs?: { href?: string }
}

export interface AdfNode {
  type: string
  /** Present only on the root `doc` node; ADF requires it there. */
  version?: number
  text?: string
  marks?: AdfMark[]
  attrs?: { level?: number; language?: string; order?: number }
  content?: AdfNode[]
}

export interface AdfDocument extends AdfNode {
  type: 'doc'
  version: 1
  content: AdfNode[]
}

/**
 * The wire shape, parsed at the adapter's I/O boundary so nothing downstream
 * carries an unvalidated body. Attributes Solus does not read are dropped
 * rather than rejected: a Jira description holds panels, media, and macros that
 * are none of this file's business, and refusing them would fail a whole sync
 * over a node it only needed to pass through.
 */
export const adfNodeSchema: z.ZodType<AdfNode> = z.lazy(() => z.object({
  type: z.string(),
  version: z.number().optional(),
  text: z.string().optional(),
  marks: z.array(z.object({
    type: z.string(),
    attrs: z.object({ href: z.string().optional() }).optional(),
  })).optional(),
  attrs: z.object({
    level: z.number().optional(),
    language: z.string().optional(),
    order: z.number().optional(),
  }).optional(),
  content: z.array(adfNodeSchema).optional(),
}))

/**
 * A body as Jira returns it: an ADF document on Cloud, a plain string on Server
 * and Data Center, or nothing at all.
 *
 * The string arm becomes a document here rather than downstream, so everything
 * past this boundary handles one shape. That text is still the author's and
 * must not read as an empty description.
 */
export const adfBodySchema = z.union([
  adfNodeSchema,
  z.string().transform((text): AdfNode => ({
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  })),
]).nullish()
export type AdfBody = z.infer<typeof adfBodySchema>

// ── markdown → ADF ──

const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/
const QUOTE = /^>\s?(.*)$/
const FENCE = /^```(\S*)\s*$/

export function markdownToAdf(markdown: string): AdfDocument {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const content: AdfNode[] = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (!line.trim()) {
      index += 1
      continue
    }

    const fence = FENCE.exec(line)
    if (fence) {
      const code: string[] = []
      index += 1
      while (index < lines.length && !FENCE.test(lines[index])) {
        code.push(lines[index])
        index += 1
      }
      index += 1 // the closing fence, or the end of the input
      const node: AdfNode = { type: 'codeBlock', content: [{ type: 'text', text: code.join('\n') }] }
      if (fence[1]) node.attrs = { language: fence[1] }
      content.push(node)
      continue
    }

    const heading = HEADING.exec(line)
    if (heading) {
      content.push({
        type: 'heading',
        attrs: { level: heading[1].length },
        content: inlineToAdf(heading[2]),
      })
      index += 1
      continue
    }

    if (/^\s*([-*_])\s*\1\s*\1[-*_\s]*$/.test(line)) {
      content.push({ type: 'rule' })
      index += 1
      continue
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = !BULLET.test(line)
      const items: AdfNode[] = []
      while (index < lines.length) {
        const match = ordered ? ORDERED.exec(lines[index]) : BULLET.exec(lines[index])
        if (!match) break
        items.push({
          type: 'listItem',
          content: [{ type: 'paragraph', content: inlineToAdf(ordered ? match[2] : match[1]) }],
        })
        index += 1
      }
      content.push({ type: ordered ? 'orderedList' : 'bulletList', content: items })
      continue
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = []
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index])
        if (!match) break
        quoted.push(match[1])
        index += 1
      }
      content.push({
        type: 'blockquote',
        content: [{ type: 'paragraph', content: inlineToAdf(quoted.join(' ')) }],
      })
      continue
    }

    // A paragraph runs to the next blank line; a hard-wrapped one is a single
    // paragraph, which is how markdown reads it.
    const paragraph: string[] = []
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
      paragraph.push(lines[index].trim())
      index += 1
    }
    if (!paragraph.length) {
      // The line starts a block the loop above already rejected; consume it as
      // text so the walk cannot stall.
      paragraph.push(lines[index].trim())
      index += 1
    }
    content.push({ type: 'paragraph', content: inlineToAdf(paragraph.join(' ')) })
  }

  // ADF rejects an empty document, and a task with no description is ordinary.
  if (!content.length) content.push({ type: 'paragraph', content: [] })
  return { type: 'doc', version: 1, content }
}

function isBlockStart(line: string): boolean {
  return HEADING.test(line) || BULLET.test(line) || ORDERED.test(line)
    || QUOTE.test(line) || FENCE.test(line)
}

const INLINE = /(\[([^\]]+)\]\(([^)\s]+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(_([^_]+)_)/

function inlineToAdf(text: string): AdfNode[] {
  const nodes: AdfNode[] = []
  let rest = text
  while (rest) {
    const match = INLINE.exec(rest)
    if (!match || match.index === undefined) break
    if (match.index > 0) nodes.push({ type: 'text', text: rest.slice(0, match.index) })
    if (match[1]) {
      nodes.push({ type: 'text', text: match[2], marks: [{ type: 'link', attrs: { href: match[3] } }] })
    } else if (match[4]) {
      nodes.push({ type: 'text', text: match[5], marks: [{ type: 'code' }] })
    } else if (match[6]) {
      nodes.push({ type: 'text', text: match[7], marks: [{ type: 'strong' }] })
    } else {
      nodes.push({ type: 'text', text: match[9] ?? match[11], marks: [{ type: 'em' }] })
    }
    rest = rest.slice(match.index + match[0].length)
  }
  if (rest) nodes.push({ type: 'text', text: rest })
  return nodes
}

// ── ADF → markdown ──

export function adfToMarkdown(body: AdfBody): string {
  if (!body) return ''
  return blocksToMarkdown(body.content ?? []).trim()
}

function blocksToMarkdown(nodes: AdfNode[]): string {
  return nodes.map((node) => blockToMarkdown(node)).filter((block) => block !== '').join('\n\n')
}

function blockToMarkdown(node: AdfNode): string {
  switch (node.type) {
    case 'paragraph':
      return inlineToMarkdown(node.content ?? [])
    case 'heading':
      return `${'#'.repeat(node.attrs?.level ?? 1)} ${inlineToMarkdown(node.content ?? [])}`
    case 'codeBlock':
      return `\`\`\`${node.attrs?.language ?? ''}\n${inlineToMarkdown(node.content ?? [])}\n\`\`\``
    case 'rule':
      return '---'
    case 'blockquote':
      return blocksToMarkdown(node.content ?? [])
        .split('\n')
        .map((line) => `> ${line}`.trimEnd())
        .join('\n')
    case 'bulletList':
    case 'orderedList':
      return listToMarkdown(node)
    default:
      // An unsupported block still carries text worth keeping.
      return node.content ? blocksToMarkdown(node.content) : (node.text ?? '')
  }
}

function listToMarkdown(list: AdfNode): string {
  const ordered = list.type === 'orderedList'
  const start = list.attrs?.order ?? 1
  return (list.content ?? []).map((item, position) => {
    const marker = ordered ? `${start + position}.` : '-'
    const body = blocksToMarkdown(item.content ?? [])
    // A nested block under a list item is indented, not promoted to top level.
    return body.split('\n').map((line, lineIndex) => (
      lineIndex === 0 ? `${marker} ${line}` : `  ${line}`.trimEnd()
    )).join('\n')
  }).join('\n')
}

function inlineToMarkdown(nodes: AdfNode[]): string {
  return nodes.map((node) => {
    if (node.type === 'hardBreak') return '\n'
    if (node.type !== 'text') {
      // Mentions, emoji, and inline cards each carry their own display text.
      return node.content ? inlineToMarkdown(node.content) : (node.text ?? '')
    }
    let text = node.text ?? ''
    for (const mark of node.marks ?? []) {
      if (mark.type === 'code') text = `\`${text}\``
      else if (mark.type === 'strong') text = `**${text}**`
      else if (mark.type === 'em') text = `*${text}*`
      else if (mark.type === 'link' && mark.attrs?.href) text = `[${text}](${mark.attrs.href})`
    }
    return text
  }).join('')
}


import { Node } from '@tiptap/core'
import { z } from 'zod'

/**
 * YAML front matter: the `---` fenced block at the very top of a skill, an
 * agent definition, or a static-site page.
 *
 * CommonMark knows nothing of it. Left to marked, the opening fence is a rule,
 * the keys run together into one paragraph, and the closing fence turns that
 * paragraph into a heading — which is what a save would then write back, and
 * the file would stop being readable by whatever owns its front matter. So the
 * block is its own node, and its YAML is kept as written.
 */

const FENCE = /^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/
/** A top-level `key:` line. A `- item` at column 0 is a list, not a key. */
const KEY_LINE = /^(?!-(?:\s|$))([^\s#][^:]*?):(?=\s|$)[ \t]*(.*)$/
/** A line that still belongs to the key above it: indented, a list item, a
 *  comment, or blank. */
const CONTINUATION_LINE = /^(?:[ \t]|-(?:\s|$)|#|$)/

export interface FrontMatterProperty {
  key: string
  /** What the reader sees: a one-line scalar without its quotes, or the YAML
   *  under the key, dedented, for a list, a map, or a block scalar. */
  value: string
  /** A one-line scalar the list edits in place. Anything richer is shown as
   *  YAML and changed in the source view, so an edit cannot reshape it. */
  isEditable: boolean
}

interface Entry extends FrontMatterProperty {
  /** Index of the entry's `key:` line in the YAML. */
  line: number
  /** The key as written, up to and including the colon. */
  head: string
  isQuoted: boolean
}

/** A complete front matter block at the head of `src`. */
export function frontMatterBlock(src: string): { raw: string; yaml: string } | null {
  const match = FENCE.exec(src)
  if (!match) return null
  const yaml = match[1] ?? ''
  // A rule, a key-like line, and a rule is also a CommonMark heading under a
  // rule. Only claim it when every line reads as YAML properties.
  if (!parseEntries(yaml)) return null
  return { raw: match[0], yaml }
}

export function frontMatterProperties(yaml: string): FrontMatterProperty[] {
  return (parseEntries(yaml) ?? []).map(({ key, value, isEditable }) => ({ key, value, isEditable }))
}

/** The YAML with one editable property's value replaced. Every other line —
 *  comments, order, quoting — is left exactly as it was. */
export function setFrontMatterValue(yaml: string, key: string, value: string): string {
  const entry = parseEntries(yaml)?.find((candidate) => candidate.key === key)
  if (!entry?.isEditable) return yaml
  const lines = yaml.split('\n')
  const scalar = yamlScalar(value, entry.isQuoted)
  lines[entry.line] = scalar ? `${entry.head} ${scalar}` : entry.head
  return lines.join('\n')
}

export function serializeFrontMatter(yaml: string): string {
  return yaml ? `---\n${yaml}\n---` : '---\n---'
}

function parseEntries(yaml: string): Entry[] | null {
  const lines = yaml === '' ? [] : yaml.split('\n')
  const entries: Entry[] = []
  let continuation: string[] = []

  const finish = () => {
    const entry = entries.at(-1)
    if (!entry) return
    const content = continuation.filter((line) => line.trim() !== '' && !line.startsWith('#'))
    if (content.length > 0) {
      entry.isEditable = false
      entry.value = [entry.value, ...dedent(content)].filter(Boolean).join('\n')
    }
    continuation = []
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const keyMatch = KEY_LINE.exec(line)
    if (keyMatch) {
      finish()
      const rest = keyMatch[2].trimEnd()
      const scalar = readScalar(rest)
      entries.push({
        key: keyMatch[1],
        head: `${keyMatch[1]}:`,
        line: index,
        value: scalar?.value ?? rest,
        isEditable: scalar !== null,
        isQuoted: rest.startsWith('"') || rest.startsWith("'"),
      })
      continue
    }
    if (!CONTINUATION_LINE.test(line)) return null
    // Comments and blank lines before the first key belong to no property.
    if (entries.length === 0 && line.trim() !== '' && !line.startsWith('#')) return null
    continuation.push(line)
  }
  finish()
  return entries
}

/** The value of a one-line scalar, or null for anything the list should not
 *  rewrite: block scalars, flow collections, anchors, tags, a trailing
 *  comment, or a quoted string with escapes JSON does not share with YAML. */
function readScalar(text: string): { value: string } | null {
  if (text.startsWith('"')) {
    try {
      const parsed = z.string().safeParse(JSON.parse(text))
      return parsed.success ? { value: parsed.data } : null
    } catch {
      return null
    }
  }
  if (text.startsWith("'")) {
    const single = /^'((?:[^']|'')*)'$/.exec(text)
    return single ? { value: single[1].replaceAll("''", "'") } : null
  }
  if (/^[|>[{&*!%@`#]/.test(text) || /\s#/.test(text)) return null
  return { value: text }
}

/** A value as YAML. Plain when it reads back as the same text; otherwise a
 *  double-quoted string, which JSON's escaping writes correctly. */
function yamlScalar(value: string, wasQuoted: boolean): string {
  if (value === '') return ''
  // A leading dash, question mark, or colon is only a marker before a space.
  const opensPlain = /^[^\s\-?:,[\]{}#&*!|>'"%@`]|^[-?:]\S/.test(value)
  const isPlainSafe = opensPlain && !/\s$/.test(value) && !/:(?:\s|$)|\s#|\n/.test(value)
  return !wasQuoted && isPlainSafe ? value : JSON.stringify(value)
}

function dedent(lines: string[]): string[] {
  const indents = lines
    .filter((line) => line.trim() !== '')
    .map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0)
  const indent = indents.length ? Math.min(...indents) : 0
  return lines.map((line) => line.slice(indent))
}

/**
 * The front matter node without its view, so the markdown round trip can be
 * exercised without a DOM. `frontMatterExtension.ts` adds the property list.
 */
export const FrontMatterMarkdownExtension = Node.create({
  name: 'frontMatter',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return { yaml: { default: '' } }
  },

  markdownTokenizer: {
    name: 'frontMatter',
    level: 'block',
    // Never a place to cut a paragraph: front matter only opens a document.
    start: () => -1,
    tokenize(src, tokens) {
      if (tokens.some((token) => token.type !== 'space')) return undefined
      const block = frontMatterBlock(src)
      if (!block) return undefined
      return { type: 'frontMatter', raw: block.raw, yaml: block.yaml }
    },
  },

  parseMarkdown(token) {
    return { type: 'frontMatter', attrs: { yaml: String(token.yaml ?? '') } }
  },

  renderMarkdown(node) {
    return serializeFrontMatter(String(node.attrs?.yaml ?? ''))
  },

  renderText({ node }) {
    return serializeFrontMatter(String(node.attrs.yaml ?? ''))
  },

  parseHTML() {
    return [{ tag: 'pre[data-front-matter]', preserveWhitespace: 'full', getAttrs: (el) => ({ yaml: el.textContent ?? '' }) }]
  },

  renderHTML({ node }) {
    return ['pre', { 'data-front-matter': '' }, String(node.attrs.yaml ?? '')]
  },
})

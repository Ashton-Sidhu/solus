import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { getSchema, type AnyExtension, type JSONContent } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import type { Schema } from '@tiptap/pm/model'
import { DOCUMENT_SCHEMA_VERSION, documentExtensions, markdownExtensions } from '@solus/document-model/schema'
import { createMarkdownParser, parseDocumentMarkdown, serializeDocumentMarkdown } from '@solus/document-model/markdown'
import { editorSchemaExtensions } from '@solus/workspace-ui/components/editor/lib/editor-schema'
import { createDiagramEmbedExtension } from '@solus/workspace-ui/components/editor/diagramEmbedExtension'
import { createArtifactEmbedExtension } from '@solus/workspace-ui/components/editor/artifactEmbedExtension'
import { createHtmlBlockExtension } from '@solus/workspace-ui/components/editor/htmlBlockExtension'
import { createMermaidBlockExtension } from '@solus/workspace-ui/components/editor/mermaidBlockExtension'
import { createPersonRefExtension } from '@solus/workspace-ui/components/editor/personRefExtension'

// Plan: docs/plans/work-editing-foundation.md §4. The host converts a work's
// markdown with the same schema the editor edits it with. A schema that does
// not know a node deletes it, so the editor's list and the host's list must be
// one list, and a round trip must neither lose content nor rewrite a stored
// work that nobody edited.

const ROOT = resolve(import.meta.dir, '../..')

/** Everything a schema decides about content, without its DOM functions. */
function describeSchema(schema: Schema) {
  const attrs = (spec: { attrs?: { [name: string]: { default?: unknown } } }) =>
    Object.fromEntries(Object.entries(spec.attrs ?? {}).map(([name, attr]) => [name, attr.default ?? null]))
  const tags = (rules: readonly { tag?: string }[] | undefined) => (rules ?? []).map((rule) => rule.tag ?? '')
  return {
    topNode: schema.topNodeType.name,
    nodes: Object.values(schema.nodes).map((type) => ({
      name: type.name,
      content: type.spec.content ?? '',
      group: type.spec.group ?? '',
      marks: type.spec.marks ?? null,
      inline: !!type.spec.inline,
      atom: !!type.spec.atom,
      code: !!type.spec.code,
      defining: !!type.spec.defining,
      isolating: !!type.spec.isolating,
      attrs: attrs(type.spec),
      parse: tags(type.spec.parseDOM),
    })),
    marks: Object.values(schema.marks).map((type) => ({
      name: type.name,
      inclusive: type.spec.inclusive ?? true,
      excludes: type.spec.excludes ?? null,
      attrs: attrs(type.spec),
      parse: tags(type.spec.parseDOM),
    })),
  }
}

const neverResolves = (src: string) => src

/** The document schema exactly as DocumentShell assembles it for a work. */
function rendererDocumentExtensions(): AnyExtension[] {
  const embed = { worksStore: { works: {}, ensureContent: async () => null }, onOpen() {}, onOpenSecondary() {} }
  return editorSchemaExtensions(neverResolves, {
    personReference: createPersonRefExtension(() => ({ kind: 'unknown' })),
    diagramEmbed: createDiagramEmbedExtension({ ...embed, contexts: new Map() }),
    artifactEmbed: createArtifactEmbedExtension({ ...embed, isDark: () => false }),
    htmlBlock: createHtmlBlockExtension({ isDark: () => false }),
    mermaidBlock: createMermaidBlockExtension({ isDark: () => false }),
  })
}

function rendererCodec() {
  return new MarkdownManager({ marked: createMarkdownParser(), extensions: rendererDocumentExtensions() })
}

/** Markdown already in the form the editor writes: opening and saving one of
 *  these must give back the same bytes. */
const CANONICAL: { [name: string]: string } = {
  'front matter': '---\nname: visual-artifacts\ndescription: "Say \\"hi\\""\ntags:\n  - one\n---\n\n# Title',
  images: '![Diagram](asset://0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png "Flow")\n\n![](https://example.com/a.png)',
  marks: 'Some *em*, **strong**, `code`, ~~gone~~, a [link](https://example.com), and **bold code**.',
  lists: '- one\n- two\n  - nested\n\n1. first\n2. second\n\n- [ ] todo\n- [x] done\n  - [ ] nested task',
  'aligned table': '| Left | Center   | Right | None |\n| :--- | :------: | ----: | ---- |\n| a    | bbbbbbbb | c     | d    |',
  'table between paragraphs': 'Before.\n\n| A   | B   |\n| --- | --- |\n| 1   | 2   |\n\nAfter.',
  mermaid: '```mermaid\ngraph TD\n  A-->B\n```',
  'mermaid source stays code': '```mermaid source\ngraph TD\n```',
  html: '```html\n<style>b{color:red}</style>\n<b>Hi</b>\n```\n\n```html render\n<div>plain</div>\n```',
  'html snippet stays code': '```html\n<div>plain</div>\n```',
  'code block': '```ts\nconst a = 1\n```',
  'diagram and artifact embeds': '[Auth flow](work://embed?workId=w1&type=diagram)\n\n[Latency](work://embed?workId=w2&type=artifact)',
  'person mention': 'Ask [@Ann \\[Ops\\] Lee](person://ref?userId=u_ann) today.',
  'escaped text': 'Not \\*em\\*, not \\[a link\\], snake\\_case, and a literal \\`tick.',
  'structure': '> A quote\n\n---\n\nLine one  \nline two',
}

/** Markdown a person or agent wrote in another form. The first save may
 *  normalize it, but it must keep the same content. */
const NON_CANONICAL: { [name: string]: string } = {
  'star bullets': '* one\n* two',
  'unlabelled Mermaid': '```\nflowchart LR\n  A[Desktop] --> B[Cloud]\n```',
  'unpadded aligned table': '| L | C | R |\n|:-|:-:|-:|\n| long cell | x | y |',
  'soft-wrapped prose': 'A paragraph that an agent\nwrapped at eighty columns.',
  'entities and escapes': '5 \\> 3 & 2 < 4, 1\\. not a list, and [^1].',
  'bare embed URL': 'work://embed?type=artifact&id=w9',
}

const ALL = { ...CANONICAL, ...NON_CANONICAL }

describe('the document schema', () => {
  test('Markdown files render labelled and detected Mermaid through their own editor schema', () => {
    const extensions = [
      ...editorSchemaExtensions(neverResolves),
      createMermaidBlockExtension({ isDark: () => false }),
    ]
    const codec = new MarkdownManager({ marked: createMarkdownParser(), extensions })
    for (const markdown of [CANONICAL.mermaid, NON_CANONICAL['unlabelled Mermaid']]) {
      expect(codec.parse(markdown)).toEqual(parseDocumentMarkdown(markdown))
    }
    expect(codec.parse(CANONICAL['mermaid source stays code']).content?.[0].type).toBe('codeBlock')
  })

  test('the editor and the host build the same schema', () => {
    // WHY: a node the host does not know is deleted from the shared document
    // for every reader. The editor adds views, never nodes, marks, or attrs.
    const host = describeSchema(getSchema(documentExtensions()))
    expect(describeSchema(getSchema(rendererDocumentExtensions()))).toEqual(host)
    expect(describeSchema(getSchema(editorSchemaExtensions(neverResolves)))).toEqual(describeSchema(getSchema(markdownExtensions())))
  })

  test('a view can only replace the node it extends', () => {
    expect(() => markdownExtensions({ image: createHtmlBlockExtension({ isDark: () => false }) })).toThrow()
  })

  test('the schema version names this exact schema', () => {
    // WHY: clients and hosts compare the version, not the schema. A node or an
    // attribute changed without a new version would pass that check and then
    // delete content. Update both together.
    const { nodes, marks } = describeSchema(getSchema(documentExtensions()))
    expect(DOCUMENT_SCHEMA_VERSION).toBe(1)
    expect(Object.fromEntries(nodes.map((node) => [node.name, Object.keys(node.attrs)]))).toEqual({
      paragraph: [], blockquote: [], bulletList: [], doc: [], hardBreak: [], heading: ['level'], horizontalRule: [],
      listItem: [], orderedList: ['start', 'type'], text: [], frontMatter: ['yaml'], codeBlock: ['language'],
      taskList: [], taskItem: ['checked'], image: ['src', 'alt', 'title', 'width', 'height'], table: [], tableRow: [],
      tableHeader: ['colspan', 'rowspan', 'colwidth', 'align'], tableCell: ['colspan', 'rowspan', 'colwidth', 'align'],
      personReference: ['userId', 'name'], diagramEmbed: ['workId', 'title'], artifactEmbed: ['workId', 'title'],
      htmlBlock: ['html', 'explicit'], mermaidBlock: ['source'],
    })
    expect(Object.fromEntries(marks.map((mark) => [mark.name, Object.keys(mark.attrs)]))).toEqual({
      link: ['href', 'target', 'rel', 'class', 'title'], bold: [], code: [], italic: [], strike: [], underline: [],
    })
  })
})

describe('the markdown codec', () => {
  test('loads and converts in a process with no DOM', async () => {
    // WHY: the host has no window. Tiptap's markdown libraries reach for one
    // for raw HTML; the codec must still import and convert without it.
    const script = `
      if (typeof window !== 'undefined' || typeof document !== 'undefined') throw new Error('a DOM is present')
      const { parseDocumentMarkdown, serializeDocumentMarkdown } = await import('@solus/document-model/markdown')
      const markdown = ${JSON.stringify(Object.values(CANONICAL).join('\n\n'))}
      const doc = parseDocumentMarkdown(markdown)
      if (serializeDocumentMarkdown(doc) !== markdown) throw new Error('round trip changed the markdown')
      if (typeof window !== 'undefined' || typeof document !== 'undefined') throw new Error('the codec created a DOM')
    `
    const child = Bun.spawn([process.execPath, '-e', script], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
    expect({ stderr, exitCode }).toEqual({ stderr: '', exitCode: 0 })
  })

  test('its import graph holds no Svelte, browser, Electron, or workspace module', () => {
    const forbidden = /^(?:svelte(?:\/|$)|electron$|@solus\/(?:workspace-ui|client-core|server)(?:\/|$))|\.svelte$/
    const transpiler = new Bun.Transpiler({ loader: 'ts' })
    const seen = new Set<string>()
    const queue = readdirSync(join(ROOT, 'packages/document-model/src')).map((file) => join(ROOT, 'packages/document-model/src', file))
    const reached: string[] = []
    while (queue.length > 0) {
      const file = queue.pop()!
      if (seen.has(file)) continue
      seen.add(file)
      for (const entry of transpiler.scanImports(readFileSync(file, 'utf8'))) {
        reached.push(entry.path)
        if (entry.path.startsWith('.')) queue.push(resolve(dirname(file), `${entry.path}.ts`))
        else if (entry.path.startsWith('@solus/contracts/')) queue.push(join(ROOT, 'packages/contracts/src', `${entry.path.slice('@solus/contracts/'.length)}.ts`))
      }
    }
    expect(reached.filter((path) => forbidden.test(path))).toEqual([])
  })

  for (const [name, markdown] of Object.entries(CANONICAL)) {
    test(`${name}: opening and saving writes back the same bytes`, () => {
      // WHY: a work is stored as markdown. Merely opening one must never
      // produce a different file, or every open would be an edit.
      expect(serializeDocumentMarkdown(parseDocumentMarkdown(markdown))).toBe(markdown)
    })
  }

  for (const [name, markdown] of Object.entries(NON_CANONICAL)) {
    test(`${name}: the first save keeps the content and the next save changes nothing`, () => {
      const doc = parseDocumentMarkdown(markdown)
      const saved = serializeDocumentMarkdown(doc)
      expect(parseDocumentMarkdown(saved)).toEqual(doc)
      expect(serializeDocumentMarkdown(parseDocumentMarkdown(saved))).toBe(saved)
    })
  }

  test('the editor reads and writes every fixture exactly as the host does', () => {
    const editor = rendererCodec()
    for (const markdown of Object.values(ALL)) {
      const doc = parseDocumentMarkdown(markdown)
      expect(editor.parse(markdown)).toEqual(doc)
      expect(editor.serialize(doc)).toBe(serializeDocumentMarkdown(doc))
    }
  })

  test('the host builds content the schema accepts', () => {
    const schema = getSchema(documentExtensions())
    for (const markdown of Object.values(ALL)) {
      const doc = parseDocumentMarkdown(markdown)
      const node = schema.nodeFromJSON(doc)
      node.check()
      // The editor holds the schema's node, with every default filled in.
      expect(serializeDocumentMarkdown(node.toJSON())).toBe(serializeDocumentMarkdown(doc))
    }
  })

  test('each custom block keeps its meaning', () => {
    const blocks = (markdown: string) => (parseDocumentMarkdown(markdown).content ?? []).map((node: JSONContent) => [node.type, node.attrs ?? {}])
    expect(blocks(CANONICAL['front matter'])[0]).toEqual(['frontMatter', { yaml: 'name: visual-artifacts\ndescription: "Say \\"hi\\""\ntags:\n  - one' }])
    expect(blocks(CANONICAL.mermaid)).toEqual([['mermaidBlock', { source: 'graph TD\n  A-->B' }]])
    expect(blocks(NON_CANONICAL['unlabelled Mermaid'])).toEqual([['mermaidBlock', { source: 'flowchart LR\n  A[Desktop] --> B[Cloud]' }]])
    expect(blocks(CANONICAL['mermaid source stays code'])[0][0]).toBe('codeBlock')
    expect(blocks(CANONICAL.html)).toEqual([
      ['htmlBlock', { html: '<style>b{color:red}</style>\n<b>Hi</b>', explicit: false }],
      ['htmlBlock', { html: '<div>plain</div>', explicit: true }],
    ])
    expect(blocks(CANONICAL['html snippet stays code'])[0][0]).toBe('codeBlock')
    expect(blocks(CANONICAL['diagram and artifact embeds'])).toEqual([
      ['diagramEmbed', { workId: 'w1', title: 'Auth flow' }],
      ['artifactEmbed', { workId: 'w2', title: 'Latency' }],
    ])
    expect(blocks(NON_CANONICAL['bare embed URL'])).toEqual([['artifactEmbed', { workId: 'w9', title: '' }]])
    const [image] = parseDocumentMarkdown(CANONICAL.images).content ?? []
    // The stored reference, never a display URL.
    expect(image.attrs?.src).toBe('asset://0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.png')
    const mention = parseDocumentMarkdown(CANONICAL['person mention']).content?.[0].content?.[1]
    expect(mention).toEqual({ type: 'personReference', attrs: { userId: 'u_ann', name: 'Ann [Ops] Lee' } })
  })

  test('an aligned table is written with its columns lined up and nothing around it', () => {
    // WHY: Tiptap's writer made the alignment row wider than the column and
    // added blank lines, so every save of a work with a table rewrote it.
    const saved = serializeDocumentMarkdown(parseDocumentMarkdown(NON_CANONICAL['unpadded aligned table']))
    expect(saved).toBe('| L         | C   | R   |\n| :-------- | :-: | --: |\n| long cell | x   | y   |')
    const aligns = parseDocumentMarkdown(saved).content?.[0].content?.[0].content?.map((cell: JSONContent) => cell.attrs?.align)
    expect(aligns).toEqual(['left', 'center', 'right'])
  })

  // Known limit: without a DOM, raw HTML in markdown (not an ```html fence) is
  // literal text on the host, while the editor parses it as HTML. The host
  // must not write such content until the codec handles it.
  test.todo('raw inline HTML such as <u>underline</u> keeps its meaning through the host codec')
})

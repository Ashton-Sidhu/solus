import { describe, expect, test } from 'bun:test'
import { adfBodySchema, adfToMarkdown, markdownToAdf } from '@solus/server/atlassian/adf'

// Jira Cloud REST v3 refuses a plain string for any body, so this conversion is
// the only way a Solus task reaches an issue at all. What matters is that the
// structure a person wrote survives the trip, and that an ADF shape Solus has
// no markdown for degrades to its text instead of vanishing.

describe('markdown to ADF', () => {
  test('carries block structure rather than one flattened paragraph', () => {
    const doc = markdownToAdf('# Title\n\nA line.\n\n- one\n- two\n\n```ts\nconst a = 1\n```')
    expect(doc.content.map((node) => node.type)).toEqual([
      'heading', 'paragraph', 'bulletList', 'codeBlock',
    ])
    expect(doc.content[0].attrs?.level).toBe(1)
    expect(doc.content[2].content).toHaveLength(2)
    expect(doc.content[3].attrs?.language).toBe('ts')
  })

  test('marks inline code, emphasis, and links rather than leaving the syntax', () => {
    // WHY: an unconverted `**bold**` reaches Jira as literal asterisks, which is
    // how a synced description slowly turns into noise.
    const [paragraph] = markdownToAdf('see `run()` and **this** at [docs](https://x.dev)').content
    expect(paragraph.content?.map((node) => [node.text, node.marks?.[0]?.type])).toEqual([
      ['see ', undefined],
      ['run()', 'code'],
      [' and ', undefined],
      ['this', 'strong'],
      [' at ', undefined],
      ['docs', 'link'],
    ])
    expect(paragraph.content?.at(-1)?.marks?.[0]?.attrs?.href).toBe('https://x.dev')
  })

  test('never emits an empty document', () => {
    // WHY: Jira rejects a doc with no content, so a task with no description
    // would fail to publish at all.
    expect(markdownToAdf('').content).toHaveLength(1)
  })
})

describe('ADF to markdown', () => {
  test('round-trips the block structure Solus writes', () => {
    const source = '# Title\n\nA line.\n\n- one\n- two\n\n```ts\nconst a = 1\n```'
    expect(adfToMarkdown(markdownToAdf(source))).toBe(source)
  })

  test('keeps the text of a node it has no markdown for', () => {
    // WHY: Jira descriptions carry panels, media, and mentions. Dropping them
    // silently would make a pull look like the author deleted the content.
    const markdown = adfToMarkdown({
      type: 'doc',
      version: 1,
      content: [{
        type: 'panel',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Heads up' }] }],
      }],
    })
    expect(markdown).toBe('Heads up')
  })

  test('reads a plain string body as itself', () => {
    // WHY: a Server/Data Center issue answers with wiki markup, not ADF. It is
    // still the author's text and must not read as an empty description.
    expect(adfToMarkdown(adfBodySchema.parse('just text'))).toBe('just text')
  })
})

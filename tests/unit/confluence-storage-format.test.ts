import { describe, expect, it, test } from 'bun:test'
import { markdownToStorage, storageToMarkdown } from '@solus/server/docs/confluence/storage-format'
import { diagramAttachments } from '@solus/server/docs/confluence/diagram-attachments'
import { serializeDiagramEmbed } from '@solus/contracts/diagram-embed'
import type { DocDiagramAsset } from '@solus/contracts/docs'

/** A PNG header is all the size reader looks at. */
function png(width: number, height: number): string {
  const header = Buffer.alloc(24)
  header.write('\x89PNG\r\n\x1a\n', 0, 'latin1')
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'latin1')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return header.toString('base64')
}

const WORK_ID = '018f0fd7-3684-426a-a0d4-4720572f99e6'

function asset(base64: string): DocDiagramAsset {
  return { workId: WORK_ID, title: 'Target Architecture', mimeType: 'image/png', base64 }
}

describe('markdownToStorage', () => {
  it('writes code blocks as the Confluence code macro, because a <pre> loses the language', () => {
    const storage = markdownToStorage('```ts\nconst a = 1\n```')
    expect(storage).toContain('<ac:structured-macro ac:name="code">')
    expect(storage).toContain('<ac:parameter ac:name="language">ts</ac:parameter>')
    expect(storage).toContain('<![CDATA[const a = 1')
  })

  it('closes every tag, since Confluence rejects a page that is not well-formed XHTML', () => {
    const storage = markdownToStorage('a  \nb\n\n---\n')
    expect(storage).toContain('<br/>')
    expect(storage).toContain('<hr/>')
    expect(storage).not.toMatch(/<br>|<hr>/)
  })

  it('escapes raw HTML rather than passing it through as markup', () => {
    expect(markdownToStorage('<script>alert(1)</script>')).not.toContain('<script>')
  })
})

describe('storageToMarkdown', () => {
  it('round-trips the structures Solus authors', () => {
    const markdown = [
      '# Title',
      '',
      'Some **bold** and _italic_ text with a [link](https://example.com).',
      '',
      '- one',
      '- two',
      '',
      '```ts',
      'const a = 1',
      '```',
    ].join('\n')

    const { markdown: roundTripped, lossyParts } = storageToMarkdown(markdownToStorage(markdown))

    expect(roundTripped).toBe(markdown)
    expect(lossyParts).toEqual([])
  })

  it('names a macro it cannot carry instead of dropping it silently', () => {
    const storage = '<p>Before</p><ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">ABC-1</ac:parameter></ac:structured-macro><p>After</p>'
    const { markdown, lossyParts } = storageToMarkdown(storage)

    expect(lossyParts).toEqual(['jira'])
    // The macro's own parameters must not leak into the prose as stray text.
    expect(markdown).toBe('Before\n\nAfter')
  })

  it('converts a table with a header row into GFM', () => {
    const storage = '<table><tbody><tr><th>Name</th><th>Role</th></tr><tr><td>Ada</td><td>Author</td></tr></tbody></table>'
    expect(storageToMarkdown(storage).markdown).toBe(
      ['| Name | Role |', '| --- | --- |', '| Ada | Author |'].join('\n'),
    )
  })

  it('keeps a nested list under its parent item', () => {
    const storage = '<ul><li><p>one</p><ul><li><p>one.a</p></li></ul></li><li><p>two</p></li></ul>'
    expect(storageToMarkdown(storage).markdown).toBe(['- one', '  - one.a', '- two'].join('\n'))
  })
})

describe('diagram embeds', () => {
  const embed = serializeDiagramEmbed({ workId: WORK_ID, title: 'Target Architecture' })

  it('publishes an embed as the page attachment holding its picture', () => {
    // WHY: Confluence shows an image only from an attachment on the page or a
    // URL it can fetch anonymously, and `work://embed` is neither.
    const storage = markdownToStorage(embed, diagramAttachments([asset(png(2083, 1562))]))

    expect(storage).toContain(`<ri:attachment ri:filename="solus-diagram-${WORK_ID}.png"/>`)
    expect(storage).toContain('ac:alt="Target Architecture"')
    // The capture carries about 500 dpi, so 2,083 pixels is a 400px picture.
    expect(storage).toContain('ac:width="400"')
    expect(storage).not.toContain('work://embed')
  })

  it('holds a wide diagram to the width of the page it is on', () => {
    // WHY: an image with no stated width renders at its own pixel size and
    // pushes the whole page sideways. Full resolution stays in the attachment.
    expect(markdownToStorage(embed, diagramAttachments([asset(png(6000, 1400))]))).toContain('ac:width="760"')
  })

  it('round-trips an embed through the page it was published to', () => {
    // WHY: without this the publish rewrites the live embed into prose, and the
    // next pull deletes the diagram from the work that owns it.
    const markdown = `# Spec\n\n${embed}\n\nAfter.`
    const storage = markdownToStorage(markdown, diagramAttachments([asset(png(800, 600))]))
    const pulled = storageToMarkdown(storage)

    expect(pulled.markdown).toBe(markdown)
    expect(pulled.lossyParts).toEqual([])
  })

  it('still names an attachment nobody published as lost', () => {
    const storage = '<p><ac:image ac:alt="Whiteboard"><ri:attachment ri:filename="photo.png"/></ac:image></p>'
    const pulled = storageToMarkdown(storage)

    expect(pulled.markdown).toBe('![Whiteboard](photo.png)')
    expect(pulled.lossyParts).toEqual(['attachment'])
  })

  it('leaves an embed alone when the publish carried no picture for it', () => {
    // The caption fallback is the doc layer's, and it only fires when nothing
    // rendered the diagram — an agent publishing from a server, for instance.
    expect(markdownToStorage(embed)).not.toContain('<ac:image')
  })
})

describe('table headers are never bolded', () => {
  test('a bold header cell publishes without <strong>, since Confluence draws it bold', () => {
    const storage = markdownToStorage('| **Term** | Meaning |\n|---|---|\n| **doc** | a thing |', new Map())
    expect(storage).toContain('<th>Term</th>')
    // A body cell keeps the emphasis the author wrote.
    expect(storage).toContain('<td><strong>doc</strong></td>')
  })

  test('a header cell Confluence returns bold reads back unbolded, so it cannot stick', () => {
    const { markdown } = storageToMarkdown(
      '<table><tbody><tr><th><strong>Term</strong></th><th>Meaning</th></tr><tr><td><strong>doc</strong></td><td>a thing</td></tr></tbody></table>',
    )
    expect(markdown).toBe('| Term | Meaning |\n| --- | --- |\n| **doc** | a thing |')
  })
})

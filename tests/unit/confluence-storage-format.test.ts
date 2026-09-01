import { describe, expect, it } from 'bun:test'
import { markdownToStorage, storageToMarkdown } from '@solus/server/docs/confluence/storage-format'

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

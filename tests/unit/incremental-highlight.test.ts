import { toHtml } from 'hast-util-to-html'
import { describe, expect, test } from 'bun:test'
import { createIncrementalHighlight, loadCodeHighlighter, plainCodeLines } from '@solus/workspace-ui/lib/incremental-highlight'

describe('incremental code highlighting', () => {
  test('matches a full pass through multiline comments, strings, and source replacement', async () => {
    const loaded = (await loadCodeHighlighter('typescript'))!
    const highlight = createIncrementalHighlight(loaded.highlighter, loaded.language)
    for (const source of ['/* open\n', '/* open\nstill comment\n*/\nconst x = `hello\n', '/* open\nstill comment\n*/\nconst x = `hello\nworld`;\n', 'const replacement = 1;', 'a\r\nb\r\n']) {
      const root = loaded.highlighter.codeToHast(source, { lang: loaded.language, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false })
      const pre = root.children.find(node => node.type === 'element' && node.tagName === 'pre')
      if (pre?.type !== 'element') throw new Error('Missing pre')
      const code = pre.children.find(node => node.type === 'element' && node.tagName === 'code')
      if (code?.type !== 'element') throw new Error('Missing code')
      const full = code.children.flatMap(node => node.type === 'element' ? [toHtml({ type: 'root', children: node.children })] : [])
      expect(highlight(source)).toEqual(full)
    }
  })
  test('does not send completed lines back through the highlighter', async () => {
    const loaded = (await loadCodeHighlighter('typescript'))!
    const highlighter = loaded.highlighter
    const original = highlighter.codeToHast
    const inputs: string[] = []
    highlighter.codeToHast = (code, options) => { inputs.push(code); return original(code, options) }
    try {
      const highlight = createIncrementalHighlight(highlighter, loaded.language)
      const first = highlight('const stable = 1;\ncon')
      inputs.length = 0
      const next = highlight('const stable = 1;\nconst next = 2;')
      expect(inputs).toEqual(['const next = 2;'])
      expect(next[0]).toBe(first[0])
    } finally { highlighter.codeToHast = original }
  })
  test('unknown languages and unavailable grammars keep escaped readable source', async () => {
    expect(await loadCodeHighlighter('not-a-language')).toBeNull()
    expect(plainCodeLines('<script>&\nend')).toEqual(['&lt;script&gt;&amp;', 'end'])
  })
})

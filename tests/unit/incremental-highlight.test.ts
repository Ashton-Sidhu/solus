import { toHtml } from 'hast-util-to-html'
import { describe, expect, test } from 'bun:test'
import { createIncrementalHighlight, loadCodeHighlighter, plainCodeLines, highlightAfterPaint } from '@solus/workspace-ui/lib/incremental-highlight'

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

test('blocks that mount with a transcript colour after it paints, in short slices', async () => {
  // WHY: a session opens with many code blocks. Colouring them all in the
  // mount was a long task before and after the first paint; plain code must
  // paint first, and colouring must leave room for input between slices.
  const frames: Array<() => void> = []
  const previousFrame = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = (callback) => { frames.push(() => callback(0)); return frames.length }
  try {
    const ran: number[] = []
    const cancelled = highlightAfterPaint(() => ran.push(-1))
    for (let block = 0; block < 20; block++) {
      highlightAfterPaint(() => {
        const until = performance.now() + 3
        while (performance.now() < until) { /* one block's highlight */ }
        ran.push(block)
      })
    }
    cancelled()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(ran).toEqual([])
    frames.shift()!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ran.length).toBeGreaterThan(0)
    expect(ran.length).toBeLessThan(20)
    while (ran.length < 20) await new Promise((resolve) => setTimeout(resolve, 1))
    expect(ran).toEqual([...Array(20).keys()])
  } finally {
    globalThis.requestAnimationFrame = previousFrame
  }
})

import { describe, expect, test } from 'bun:test'
import { highlightAfterPaint, loadCodeHighlighter, plainCodeLines } from '@solus/workspace-ui/lib/code-highlight'

const styleOf = (span: string) => /style="([^"]*)"/.exec(span)?.[1]

describe('code block highlighting', () => {
  test('colours each line for both themes and keeps lexer state across lines', async () => {
    // WHY: a block shows the right colours in light and dark mode without a
    // second pass, and a comment that spans lines stays a comment on each.
    const highlight = (await loadCodeHighlighter('TypeScript'))!
    const lines = highlight('/* open\nstill */ const x = 1')
    expect(lines).toHaveLength(2)
    const comment = styleOf(lines[0]!)
    expect(comment).toMatch(/^--hls-dark:#[0-9a-f]{6};--hls-light:#[0-9a-f]{6}$/)
    expect(lines[1]).toStartWith(`<span style="${comment}">still */ </span>`)
    const keyword = /<span style="([^"]*)">const /.exec(lines[1]!)?.[1]
    expect(keyword).toBeDefined()
    expect(keyword).not.toBe(comment)
  })

  test('escapes markup and drops the carriage return of a CRLF line end', async () => {
    // WHY: the block renders each line with @html and joins lines with a
    // newline, so source text must not become markup or a second line break.
    const highlight = (await loadCodeHighlighter('ts'))!
    const lines = highlight('"<b>&"\r\nend')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('"&lt;b&gt;&amp;"')
    expect(lines[0]).not.toContain('<b>')
    expect(lines.join('\n')).not.toContain('\r')
  })

  test('a streamed block keeps the markup of its completed lines', async () => {
    // WHY: a line whose markup is unchanged keeps its DOM while the block streams.
    const highlight = (await loadCodeHighlighter('typescript'))!
    const first = highlight('const stable = 1;\ncon')
    const next = highlight('const stable = 1;\nconst next = 2;')
    expect(next[0]).toBe(first[0]!)
    expect(next[1]).not.toBe(first[1]!)
  })

  test('a very long line is one span, and the lines after it keep their colours', async () => {
    // WHY: a pasted minified file must not create thousands of spans for one
    // line, and the lexer must still read it so a comment after it is right.
    const highlight = (await loadCodeHighlighter('ts'))!
    const lines = highlight(`${'const x = 1; '.repeat(200)}/* open\nstill */ let y`)
    expect(lines[0]!.match(/<span/g)).toHaveLength(1)
    expect(lines[1]).toStartWith('<span style="')
    expect(styleOf(lines[1]!)).toBe(styleOf(highlight('/* comment */')[0]!))
  })

  test('unknown and plain languages keep escaped readable source', async () => {
    expect(await loadCodeHighlighter('not-a-language')).toBeNull()
    expect(await loadCodeHighlighter('text')).toBeNull()
    expect(plainCodeLines('<script>&\nend')).toEqual(['&lt;script&gt;&amp;', 'end'])
  })
})

test('blocks that mount before the tokenizer loads colour after paint, in short slices', async () => {
  // WHY: a session can open with many code blocks before the first load.
  // Colouring them all in one task was a long task; plain code must paint
  // first, and colouring must leave room for input between slices.
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

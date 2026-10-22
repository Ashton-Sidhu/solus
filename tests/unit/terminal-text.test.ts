import { describe, expect, test } from 'bun:test'
import { plainTerminalText, terminalLines } from '@solus/client-core/terminal-text'

/**
 * A background command's output is drawn as the terminal showed it: the
 * colours the tool printed, and the lines a person scans for. What a terminal
 * would not draw — cursor moves, window titles — never reaches the reader.
 */
describe('terminal text', () => {
  test('keeps the colours a test runner printed, span by span', () => {
    const lines = terminalLines('\u001b[32m 42 pass\u001b[0m\n\u001b[1;31m 1 fail\u001b[0m total')
    expect(lines).toHaveLength(2)
    expect(lines[0]!.spans).toEqual([{ text: ' 42 pass', color: 'green', bright: false, bold: false, dim: false }])
    expect(lines[1]!.spans).toEqual([
      { text: ' 1 fail', color: 'red', bright: false, bold: true, dim: false },
      { text: ' total', color: null, bright: false, bold: false, dim: false },
    ])
  })

  test('a style stays open across lines, as in a terminal, and bright colours are kept apart', () => {
    const lines = terminalLines('\u001b[93mwarn\nstill warn\u001b[39m plain')
    expect(lines[0]!.spans[0]).toMatchObject({ color: 'yellow', bright: true })
    expect(lines[1]!.spans[0]).toMatchObject({ text: 'still warn', color: 'yellow', bright: true })
    expect(lines[1]!.spans[1]).toMatchObject({ text: ' plain', color: null })
  })

  test('drops what a terminal would not draw, and reads 256-colour as the default', () => {
    // WHY: a progress bar's cursor moves and a shell's window title are
    // control, not output. Shown raw they are the noise people complain about.
    const lines = terminalLines('\u001b]0;my shell\u0007\u001b[2K\u001b[1A\u001b[38;5;208mbuilding\u001b[0m done\r\n')
    // The 256-colour word and the plain word share the default colour, so they are one span.
    expect(lines[0]!.spans).toEqual([{ text: 'building done', color: null, bright: false, bold: false, dim: false }])
    expect(plainTerminalText('\u001b[31mred\u001b[0m\r\nnext')).toBe('red\nnext')
  })

  test('reads a line for an error or a warning by its words, whatever its colour', () => {
    const lines = terminalLines('src/a.ts:3:1: error: oops\nsrc/b.ts:9:2: warning: unused\nall good')
    expect(lines.map((line) => line.tone)).toEqual(['error', 'warning', null])
  })
})

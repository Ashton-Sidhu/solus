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

  test('consumes every control sequence form, whatever its parameters', () => {
    // WHY: only digits and semicolons used to match, so these left their tail
    // on screen as text.
    for (const sequence of ['?25l', '>4;2m', '?1m', '1$J', '1$m', '1.5A', '1:2A', '=1c', ' q']) {
      expect(plainTerminalText(`before\u001b[${sequence}after`)).toBe('beforeafter')
    }
  })

  test('a private or intermediate form ending in m changes no style', () => {
    const lines = terminalLines('\u001b[31mred\u001b[?0m\u001b[0$m still red')
    expect(lines[0]!.spans).toEqual([{ text: 'red still red', color: 'red', bright: false, bold: false, dim: false }])
  })

  test('colon colours are consumed like their semicolon forms', () => {
    const lines = terminalLines('\u001b[31mred\u001b[38:2::1:2:3;1mtrue\u001b[0m\u001b[32;48:5:1mgreen\u001b[4:3m curly')
    expect(plainTerminalText('\u001b[38:2::1:2:3mtrue')).toBe('true')
    expect(lines[0]!.spans).toEqual([
      { text: 'red', color: 'red', bright: false, bold: false, dim: false },
      { text: 'true', color: null, bright: false, bold: true, dim: false },
      { text: 'green curly', color: 'green', bright: false, bold: false, dim: false },
    ])
  })

  test('a colon field never splits into separate codes, and an empty SGR still resets', () => {
    const lines = terminalLines('\u001b[1mbold\u001b[mplain\u001b[0:1mstill')
    expect(lines[0]!.spans).toEqual([
      { text: 'bold', color: null, bright: false, bold: true, dim: false },
      { text: 'plainstill', color: null, bright: false, bold: false, dim: false },
    ])
  })

  test('reads a line for an error or a warning by its words, whatever its colour', () => {
    const lines = terminalLines('src/a.ts:3:1: error: oops\nsrc/b.ts:9:2: warning: unused\nall good')
    expect(lines.map((line) => line.tone)).toEqual(['error', 'warning', null])
  })

  test('an escape with intermediate bytes never shows its bytes', () => {
    // WHY: `tput sgr0` and many TUIs print `ESC ( B`. Shown raw, a stray "(B"
    // lands in the middle of the output.
    for (const sequence of ['(B', '#8', '%G', ' F', '7', '=', 'c']) {
      expect(plainTerminalText(`a\u001b${sequence}b`)).toBe('ab')
    }
    // A newline or a new escape is not a final byte. It stays and is read.
    expect(plainTerminalText('a\u001b#\n8b')).toBe('a\n8b')
    expect(terminalLines('a\u001b#\u001b[31mb')[0]!.spans.at(-1)).toMatchObject({ text: 'b', color: 'red' })
  })

  test('a control string with no terminator ends at the line or the next escape', () => {
    // WHY: the title of a process killed mid-print is control, not output.
    expect(plainTerminalText('ok\u001b]0;title\nnext')).toBe('ok\nnext')
    expect(plainTerminalText('ok\u001bPq#0;2;0;0;0\nnext')).toBe('ok\nnext')
    const lines = terminalLines('ok\u001b]0;title\u001b\u001b[31mred')
    expect(lines[0]!.spans.map((span) => [span.text, span.color])).toEqual([['ok', null], ['red', 'red']])
  })

  test('an underline colour leaves the text style alone', () => {
    // WHY: read as plain codes, the 0 of `58;2;255;0;0` is a reset and the 31
    // of `58;5;31` is red. The text must keep the style it had.
    expect(terminalLines('\u001b[1;32mA\u001b[58;2;255;0;0mB')[0]!.spans).toEqual([
      { text: 'AB', color: 'green', bright: false, bold: true, dim: false },
    ])
    expect(terminalLines('\u001b[58;5;31mB')[0]!.spans[0]).toMatchObject({ color: null })
  })
})

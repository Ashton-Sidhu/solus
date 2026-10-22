// A command's output, read the way a terminal would show it. Codex hands the
// output over as the bytes the command printed, colour codes included; this
// turns them into lines of coloured spans so a client can draw a test runner's
// green and red as the person saw it, and strips the escapes it does not draw
// (cursor moves, titles) so they never show as noise.
//
// Only SGR — the colour and weight codes — is kept: the 16 named colours, bold,
// dim, and reset. 256-colour and true-colour selections are consumed and drawn
// as the default colour, so an unusual palette costs nothing but its hue.

import { rawLineTone } from './device-run-log'

export type TerminalColor = 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white'

export interface TerminalSpan {
  text: string
  color: TerminalColor | null
  bright: boolean
  bold: boolean
  dim: boolean
}

export interface TerminalLine {
  spans: TerminalSpan[]
  /** The whole line's reading, from its words rather than its colours: a
   *  compiler error, a failed build. A plain line is null. */
  tone: 'error' | 'warning' | null
}

const COLORS: TerminalColor[] = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']

// CSI sequences (`ESC [ params letter`) and OSC strings (`ESC ] … BEL|ST`),
// then any other lone escape. Only CSI ending in `m` carries SGR. The
// control characters are the point: the escape byte and the bell are what
// this expression exists to find.
// eslint-disable-next-line no-control-regex
const ESCAPE = /\u001b\[([0-9;]*)([@-~])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]?/g

interface Style { color: TerminalColor | null; bright: boolean; bold: boolean; dim: boolean }
const PLAIN: Style = { color: null, bright: false, bold: false, dim: false }

/** The output as lines of spans. A line keeps the style the previous line
 *  left open, as a terminal does. */
export function terminalLines(output: string): TerminalLine[] {
  let style: Style = PLAIN
  const lines: TerminalLine[] = []
  let spans: TerminalSpan[] = []
  let plain = ''

  const push = (text: string) => {
    if (!text) return
    plain += text
    const last = spans[spans.length - 1]
    if (last && sameStyle(last, style)) last.text += text
    else spans.push({ text, ...style })
  }
  const endLine = () => {
    lines.push({ spans, tone: rawLineTone(plain) })
    spans = []
    plain = ''
  }

  let at = 0
  for (const match of output.matchAll(ESCAPE)) {
    pushText(output.slice(at, match.index), push, endLine)
    at = match.index + match[0].length
    if (match[2] === 'm') style = applySgr(style, match[1] ?? '')
  }
  pushText(output.slice(at), push, endLine)
  endLine()
  return lines
}

function pushText(text: string, push: (text: string) => void, endLine: () => void): void {
  const parts = text.split('\n')
  parts.forEach((part, index) => {
    push(part.replace(/\r$/, ''))
    if (index < parts.length - 1) endLine()
  })
}

function sameStyle(a: Style, b: Style): boolean {
  return a.color === b.color && a.bright === b.bright && a.bold === b.bold && a.dim === b.dim
}

function applySgr(style: Style, params: string): Style {
  const codes = params === '' ? [0] : params.split(';').map((code) => Number(code))
  let next = { ...style }
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]!
    if (code === 0) next = { ...PLAIN }
    else if (code === 1) next.bold = true
    else if (code === 2) next.dim = true
    else if (code === 22) { next.bold = false; next.dim = false }
    else if (code >= 30 && code <= 37) { next.color = COLORS[code - 30]!; next.bright = false }
    else if (code >= 90 && code <= 97) { next.color = COLORS[code - 90]!; next.bright = true }
    else if (code === 39) { next.color = null; next.bright = false }
    else if (code === 38 || code === 48) {
      // Extended colour: `38;5;n` or `38;2;r;g;b`. Consumed, not drawn.
      const mode = codes[i + 1]
      i += mode === 5 ? 2 : mode === 2 ? 4 : 0
      if (code === 38) { next.color = null; next.bright = false }
    }
  }
  return next
}

/** The output with every escape removed: what a copy puts on the clipboard. */
export function plainTerminalText(output: string): string {
  return output.replace(ESCAPE, '').replace(/\r\n?/g, '\n')
}

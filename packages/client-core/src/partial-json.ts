import type { z } from 'zod'

type JsonValue = z.infer<ReturnType<typeof z.json>>
type JsonFrame = { kind: 'object'; expects: 'key' | 'colon' | 'value' | 'comma' } | { kind: 'array'; expects: 'value' | 'comma' }
const WHOLE_ATOM = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)$/

/**
 * The value of a JSON text that was cut while it streamed. A cut string is
 * closed (a cut escape is dropped first), a key with no value and a cut number
 * or literal are dropped, and each open array and object is closed. Undefined
 * when nothing whole is left or the text is not JSON.
 */
export function healPartialJson(text: string): JsonValue | undefined {
  return new PartialJsonHealer(text).healed()
}

/** A cut JSON text as it is read: what is kept, and up to where it closes into JSON. */
class PartialJsonHealer {
  readonly #text: string
  #index = 0
  #out = ''
  /** The end of the last whole value or open bracket: cut there, the text closes into JSON. */
  #safe = 0
  readonly #frames: JsonFrame[] = []
  /** The rest of the text can still grow, so it is dropped. */
  #isCut = false

  constructor(text: string) {
    this.#text = text
  }

  healed(): JsonValue | undefined {
    while (!this.#isCut && this.#index < this.#text.length) this.#readToken()
    if (this.#safe === 0) return undefined
    const closers = this.#frames.map((frame) => (frame.kind === 'object' ? '}' : ']')).reverse().join('')
    try {
      return JSON.parse(this.#out.slice(0, this.#safe) + closers)
    } catch {
      return undefined
    }
  }

  #readToken(): void {
    const char = this.#text[this.#index]
    if (char === ' ' || char === '\n' || char === '\r' || char === '\t') this.#index++
    else if (char === '"') this.#readString()
    else if (char === '{' || char === '[') {
      this.#out += char
      this.#frames.push(char === '{' ? { kind: 'object', expects: 'key' } : { kind: 'array', expects: 'value' })
      this.#safe = this.#out.length
      this.#index++
    } else if (char === '}' || char === ']') {
      this.#out += char
      this.#frames.pop()
      this.#valueEnded()
      this.#index++
    } else if (char === ':' || char === ',') {
      this.#out += char
      const top = this.#frames.at(-1)
      if (top) top.expects = char === ':' ? 'value' : top.kind === 'object' ? 'key' : 'value'
      this.#index++
    } else this.#readAtom()
  }

  #valueEnded(): void {
    const top = this.#frames.at(-1)
    if (top) top.expects = 'comma'
    this.#safe = this.#out.length
  }

  /** A whole string is kept; a cut value is closed, and a cut key is dropped. */
  #readString(): void {
    const top = this.#frames.at(-1)
    const isKey = top?.kind === 'object' && top.expects === 'key'
    const end = stringEnd(this.#text, this.#index)
    if (end < 0) {
      this.#isCut = true
      if (isKey) return
      this.#out += closedString(this.#text.slice(this.#index))
      this.#valueEnded()
      return
    }
    this.#out += this.#text.slice(this.#index, end)
    this.#index = end
    if (isKey) top.expects = 'colon'
    else this.#valueEnded()
  }

  /** A number or a literal. The last one may still grow: only a whole one is kept. */
  #readAtom(): void {
    const atom = /^[^\s,:[\]{}"]+/.exec(this.#text.slice(this.#index))?.[0] ?? this.#text[this.#index]
    this.#index += atom.length
    if (this.#index >= this.#text.length && !WHOLE_ATOM.test(atom)) {
      this.#isCut = true
      return
    }
    this.#out += atom
    this.#valueEnded()
  }
}

/** The index after the closing quote of the string at `start`, or -1 when it is cut. */
function stringEnd(text: string, start: number): number {
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') index++
    else if (text[index] === '"') return index + 1
  }
  return -1
}

/** A cut string, closed: a cut escape at its end is dropped. */
function closedString(cut: string): string {
  const trailing = /\\+$/.exec(cut)?.[0].length ?? 0
  const text = (trailing % 2 ? cut.slice(0, -1) : cut).replace(/\\u[0-9a-fA-F]{0,3}$/, '')
  return `${text}"`
}

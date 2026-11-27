import { APP_CALLER_KINDS, type AppCallQueryField, type AppCallTerm } from '@solus/contracts/apps'

/**
 * The query of the Activity section (docs/plans/apps.md §9.2), as the person
 * types it: `operation:summarizeRelease or caller:workflow`, `outcome:failed`,
 * `version is 14`, or free text. Terms side by side must all match; `or`
 * joins two terms so that one of them must match. A `-` before a field term
 * turns it over: `-outcome:failed` matches every call that did not fail. Words that name no field
 * are one phrase the host finds anywhere in the call, as the old search did.
 * The host applies the query (`match` of `appCalls`); this module only reads
 * the text. Pure, so the syntax is tested.
 */

/** How one piece of the text reads, for the colours of the field. */
export type CallQueryTokenKind = 'space' | 'field' | 'value' | 'operator' | 'text' | 'invalid'

export interface CallQueryToken {
  kind: CallQueryTokenKind
  text: string
}

export interface ParsedCallQuery {
  /** Every group must match; a group matches when one of its terms does. */
  groups: AppCallTerm[][]
  /** The whole text in pieces, in order: joined, they give the text again. */
  tokens: CallQueryToken[]
  /** What is wrong with the first term that cannot match, or null. */
  problem: string | null
}

/** The names a person can type for each field. */
const FIELD_NAMES = new Map<string, AppCallQueryField>([
  ['operation', 'operation'],
  ['op', 'operation'],
  ['caller', 'caller'],
  ['outcome', 'outcome'],
  ['status', 'outcome'],
  ['version', 'version'],
  ['run', 'run'],
  ['error', 'error'],
  ['text', 'text'],
])

const OUTCOMES = ['ok', 'failed', 'running'] as const

/** The field a name stands for, in any case; null when it names none. */
export function callQueryField(name: string): AppCallQueryField | null {
  return FIELD_NAMES.get(name.toLowerCase()) ?? null
}

/** Why a value can never match its field; null when it can. */
function valueProblem(field: AppCallQueryField, value: string): string | null {
  const lower = value.toLowerCase()
  if (field === 'outcome' && !OUTCOMES.some((outcome) => outcome === lower)) return `outcome is ok, failed, or running, not “${value}”.`
  if (field === 'caller' && !APP_CALLER_KINDS.some((kind) => kind === lower)) return `caller is ${APP_CALLER_KINDS.join(', ')}, not “${value}”.`
  if (field === 'version' && !/^v?\d+$/i.test(value)) return `version is a number, not “${value}”.`
  return null
}

interface Piece {
  text: string
  /** The text without its quotes. */
  bare: string
  isQuoted: boolean
  isSpace: boolean
}

/** Cuts the text into spaces, words, and quoted phrases. A word keeps a quoted value after its colon: `error:"took longer"`. */
function pieces(text: string): Piece[] {
  const found: Piece[] = []
  let index = 0
  while (index < text.length) {
    const start = index
    if (/\s/.test(text[index])) {
      while (index < text.length && /\s/.test(text[index])) index += 1
      found.push({ text: text.slice(start, index), bare: '', isQuoted: false, isSpace: true })
      continue
    }
    let isQuoted = false
    while (index < text.length && !/\s/.test(text[index])) {
      if (text[index] === '"') {
        isQuoted = true
        const close = text.indexOf('"', index + 1)
        index = close === -1 ? text.length : close + 1
      } else {
        index += 1
      }
    }
    const piece = text.slice(start, index)
    found.push({ text: piece, bare: piece.replaceAll('"', ''), isQuoted, isSpace: false })
  }
  return found
}

/** What was read last: a term joins the group before it after `or`, and a word joins the phrase before it. */
type LastRead = 'none' | 'term' | 'text' | 'or'

/** Reads the pieces of a query one at a time, into its groups and its coloured tokens. */
class CallQueryReader implements ParsedCallQuery {
  readonly groups: AppCallTerm[][] = []
  readonly tokens: CallQueryToken[] = []
  problem: string | null = null
  private last: LastRead = 'none'

  constructor(private readonly all: readonly Piece[]) {}

  read(): this {
    for (let index = 0; index < this.all.length; index += 1) index += this.readPiece(index)
    return this
  }

  /** Reads the piece at `index`, and answers how many pieces after it it took too. */
  private readPiece(index: number): number {
    const piece = this.all[index]
    if (piece.isSpace) {
      this.tokens.push({ kind: 'space', text: piece.text })
      return 0
    }
    const lower = piece.text.toLowerCase()
    if (!piece.isQuoted && (lower === 'or' || lower === 'and') && this.last !== 'none') {
      this.tokens.push({ kind: 'operator', text: piece.text })
      if (lower === 'or') this.last = 'or'
      else if (this.last === 'text') this.last = 'term'
      return 0
    }
    if (this.readColonTerm(piece)) return 0
    if (this.readIsTerm(index)) return 4
    const bare = piece.bare.trim()
    this.tokens.push({ kind: 'text', text: piece.text })
    if (bare && piece.isQuoted) this.addTerm({ field: 'text', value: bare })
    else if (bare) this.addText(bare)
    return 0
  }

  /** `field:value`, where the value can be quoted, or `-field:value` for every call it does not match. */
  private readColonTerm(piece: Piece): boolean {
    const not = piece.text.startsWith('-')
    const text = not ? piece.text.slice(1) : piece.text
    const colon = text.indexOf(':')
    const field = colon > 0 && !text.slice(0, colon).includes('"') ? callQueryField(text.slice(0, colon)) : null
    if (!field) return false
    const valueText = text.slice(colon + 1)
    const value = valueText.replaceAll('"', '').trim()
    if (not) this.tokens.push({ kind: 'operator', text: '-' })
    this.tokens.push({ kind: 'field', text: text.slice(0, colon + 1) })
    if (valueText) this.tokens.push({ kind: value ? this.addFieldTerm(field, value, not) : 'value', text: valueText })
    return true
  }

  /** `field is value`: three words and the two spaces between them. */
  private readIsTerm(index: number): boolean {
    const [piece, firstSpace, verb, secondSpace, valuePiece] = this.all.slice(index, index + 5)
    const field = piece.isQuoted ? null : callQueryField(piece.text)
    if (!field || verb?.text.toLowerCase() !== 'is' || !valuePiece || valuePiece.isSpace || !valuePiece.bare.trim()) return false
    this.tokens.push({ kind: 'field', text: piece.text }, { kind: 'space', text: firstSpace.text }, { kind: 'field', text: verb.text }, { kind: 'space', text: secondSpace.text })
    this.tokens.push({ kind: this.addFieldTerm(field, valuePiece.bare.trim()), text: valuePiece.text })
    return true
  }

  private addTerm(term: AppCallTerm): void {
    const group = this.groups.at(-1)
    if (this.last === 'or' && group) group.push(term)
    else this.groups.push([term])
    this.last = term.field === 'text' ? 'text' : 'term'
  }

  /** Words side by side are one phrase, as the search before the query read them. */
  private addText(value: string): void {
    const previous = this.groups.at(-1)?.at(-1)
    if (this.last === 'text' && previous?.field === 'text') previous.value = `${previous.value} ${value}`
    else this.addTerm({ field: 'text', value })
  }

  private addFieldTerm(field: AppCallQueryField, value: string, not = false): CallQueryTokenKind {
    const reason = valueProblem(field, value)
    this.problem ??= reason
    this.addTerm(not ? { field, value, not } : { field, value })
    return reason ? 'invalid' : 'value'
  }
}

export function parseCallQuery(text: string): ParsedCallQuery {
  const reader = new CallQueryReader(pieces(text)).read()
  return { groups: reader.groups, tokens: reader.tokens, problem: reader.problem }
}

/** One term as the query field writes it: `outcome:failed`, `error:"took longer"`, `-run:run_8f2c`. */
export function callTermText(term: AppCallTerm): string {
  const value = /[\s"]/.test(term.value) ? `"${term.value.replaceAll('"', '')}"` : term.value
  if (term.not) return `-${term.field}:${value}`
  return term.field === 'text' ? value : `${term.field}:${value}`
}

/** One term as a filter chip says it: `version is 14`, `outcome is not failed`. */
export function callTermLabel(term: AppCallTerm): string {
  if (term.field === 'text') return term.not ? `not “${term.value}”` : `“${term.value}”`
  return `${term.field} is ${term.not ? 'not ' : ''}${term.value}`
}

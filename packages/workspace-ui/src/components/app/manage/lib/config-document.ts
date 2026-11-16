import { z } from 'zod'
import { appConfigValueProblem, type AppConfigField, type AppConfigState, type AppConfigValue } from '@solus/contracts/apps'
import type { CodeLineMark, CodeProblem } from '../../../code-editor/lib/code-marks'

/**
 * The Config section's editor (docs/plans/apps.md §4.4, §9.2) in plain terms:
 * the app's config as one JSON document, and what the owner's edit of it says
 * — which fields change, and each problem with where it is and its quick fix.
 * The active version's fields are the only rules. Pure, so the rules are
 * tested without a host.
 *
 * The document is one flat object: each key is a field's name, each value
 * that field's value. A key the owner removes goes back to its default.
 */

/** The document of the config: each field with its saved value, or with its default. */
export function configDocumentText(fields: readonly AppConfigState[], pick: 'value' | 'default' = 'value'): string {
  if (fields.length === 0) return '{}'
  const lines = fields.map((field, index) => `  ${JSON.stringify(field.name)}: ${JSON.stringify(pick === 'value' ? field.value : field.default)}${index < fields.length - 1 ? ',' : ''}`)
  return `{\n${lines.join('\n')}\n}`
}

/** One way to fix a problem: the value text that replaces the one in the document. */
export interface ConfigFix {
  /** The words of the fix, "Use 90". */
  label: string
  /** The JSON text that replaces the value. */
  text: string
}

export interface ConfigProblem {
  /** The first words, "Out of range." */
  title: string
  /** One sentence: what the field takes. */
  message: string
  /** The line, from 1, and the span of the document the problem is about. */
  line: number
  from: number
  to: number
  fix: ConfigFix | null
}

/** What one line of the document stands for, against what is saved. */
export type ConfigEntryState = 'changed' | 'default' | 'saved'

/** One key of the document. */
export interface ConfigEntry {
  name: string
  /** The declared field; null for a key the app does not declare. */
  field: AppConfigState | null
  line: number
  valueFrom: number
  valueTo: number
  /** The value the document gives the field; null when it is not a value the field takes. */
  value: AppConfigValue | null
  state: ConfigEntryState
}

/** What a change sends: the field's new value, or null to give it its default again. */
export interface ConfigChange {
  field: AppConfigState
  value: AppConfigValue | null
}

export interface ConfigAnalysis {
  entries: ConfigEntry[]
  problems: ConfigProblem[]
  /** One for each field whose value the document changes. Save sends them when there is no problem. */
  changes: ConfigChange[]
}

/** The editor bar's count: "2 changes · 1 problem". */
export function configEditSummary(analysis: Pick<ConfigAnalysis, 'changes' | 'problems'>): string {
  const changes = analysis.changes.length
  const problems = analysis.problems.length
  const parts = [changes === 1 ? '1 change' : `${changes} changes`]
  if (problems > 0) parts.push(problems === 1 ? '1 problem' : `${problems} problems`)
  return parts.join(' · ')
}

/** The field a line of the document is about: the entry on that line, if any. */
export function configEntryAtLine(analysis: ConfigAnalysis, line: number): ConfigEntry | null {
  return analysis.entries.find((entry) => entry.line === line) ?? null
}

/**
 * What the code editor draws for an analysis: each problem with its quick
 * fix, a changed line with what it was ("was 14"), and a line at its
 * default ("default").
 */
export interface ConfigCodeMarks {
  problems: CodeProblem[]
  lines: CodeLineMark[]
}

export function configCodeMarks(analysis: ConfigAnalysis): ConfigCodeMarks {
  const problems = analysis.problems.map((problem): CodeProblem => ({ ...problem, fix: problem.fix ? { label: problem.fix.label, insert: problem.fix.text } : null }))
  const lines = analysis.entries.flatMap((entry): CodeLineMark[] => {
    const field = entry.field
    if (entry.state === 'changed') {
      const isText = field?.type === 'text' || field?.type === 'choice' || field?.type === 'model'
      return [{ line: entry.line, isChanged: true, hint: field ? `was ${isText ? JSON.stringify(field.value) : String(field.value)}` : null, isQuietHint: false }]
    }
    if (entry.state === 'default' && field) return [{ line: entry.line, isChanged: false, hint: 'default', isQuietHint: true }]
    return []
  })
  return { problems, lines }
}

/** Reads the owner's document against the fields of the active version. */
export function analyzeConfigDocument(text: string, fields: readonly AppConfigState[]): ConfigAnalysis {
  const lineOf = lineFinder(text)
  const scan = scanFlatObject(text)
  const problems: ConfigProblem[] = []
  if ('error' in scan) {
    problems.push({ title: 'Not valid JSON.', message: scan.error.message, line: lineOf(scan.error.at), from: scan.error.at, to: Math.min(text.length, scan.error.at + 1), fix: null })
    return { entries: [], problems, changes: [] }
  }

  const byName = new Map(fields.map((field) => [field.name, field]))
  const seen = new Set<string>()
  const entries: ConfigEntry[] = []
  const given = new Map<string, AppConfigValue>()
  for (const pair of scan.pairs) {
    const field = byName.get(pair.key) ?? null
    const line = lineOf(pair.keyFrom)
    const span = { line, from: pair.valueFrom, to: pair.valueTo }
    if (seen.has(pair.key)) {
      problems.push({ title: 'Set twice.', message: `${pair.key} is set more than once. Keep one.`, line, from: pair.keyFrom, to: pair.keyTo, fix: null })
      continue
    }
    seen.add(pair.key)
    if (!field) {
      problems.push({ title: 'Unknown setting.', message: `The app declares no setting named ${pair.key}.`, line, from: pair.keyFrom, to: pair.keyTo, fix: null })
      entries.push({ name: pair.key, field: null, line, valueFrom: pair.valueFrom, valueTo: pair.valueTo, value: null, state: 'changed' })
      continue
    }
    const checked = checkValue(field, pair.value)
    if ('problem' in checked) problems.push({ ...checked.problem, ...span })
    const value = 'value' in checked ? checked.value : null
    if (value !== null) given.set(field.name, value)
    const state: ConfigEntryState = value === null || value !== field.value ? 'changed' : field.isDefault ? 'default' : 'saved'
    entries.push({ name: field.name, field, line, valueFrom: pair.valueFrom, valueTo: pair.valueTo, value, state })
  }

  const changes: ConfigChange[] = []
  for (const field of fields) {
    if (!seen.has(field.name)) {
      // A removed key gives the field its default again.
      if (!field.isDefault) changes.push({ field, value: null })
      continue
    }
    const value = given.get(field.name)
    if (value === undefined || value === field.value) continue
    changes.push({ field, value: value === field.default ? null : value })
  }
  return { entries, problems, changes }
}

/** The words of a field's type, for the inspector. */
export function configTypeText(field: AppConfigField): string {
  switch (field.type) {
    case 'text':
      return field.multiline ? 'Text, several lines' : 'Text'
    case 'number':
      return field.integer ? 'Whole number' : 'Number'
    case 'boolean':
      return 'On or off'
    case 'choice':
      return 'Choice'
    case 'model':
      return 'Model id'
  }
}

/** What a number field takes, "1 to 90", or null when it has no limit. */
export function configRangeText(field: AppConfigField): string | null {
  if (field.type !== 'number') return null
  if (field.min !== undefined && field.max !== undefined) return `${field.min} to ${field.max}`
  if (field.min !== undefined) return `At least ${field.min}`
  if (field.max !== undefined) return `At most ${field.max}`
  return null
}

/** The document with one field's value replaced by `valueText`, or with the field added before the closing brace. Null when the document is not an object. */
export function replaceConfigValue(text: string, analysis: ConfigAnalysis, name: string, valueText: string): { from: number; to: number; insert: string } | null {
  const entry = analysis.entries.find((candidate) => candidate.name === name)
  if (entry) return { from: entry.valueFrom, to: entry.valueTo, insert: valueText }
  const close = text.lastIndexOf('}')
  if (close === -1 || analysis.problems.some((problem) => problem.title === 'Not valid JSON.')) return null
  const before = text.slice(0, close).trimEnd()
  const needsComma = !before.endsWith('{')
  const from = before.length
  return { from, to: close, insert: `${needsComma ? ',' : ''}\n  ${JSON.stringify(name)}: ${valueText}\n` }
}

// ─── The value rules ───

function describeTakes(field: AppConfigField): string {
  switch (field.type) {
    case 'text':
      return 'text in quotes'
    case 'number': {
      const kind = field.integer ? 'a whole number' : 'a number'
      const range = configRangeText(field)
      return range ? `${kind} ${field.min !== undefined && field.max !== undefined ? `from ${field.min} to ${field.max}` : range.toLowerCase()}` : kind
    }
    case 'boolean':
      return 'true or false'
    case 'choice':
      return `one of ${field.options.map((option) => JSON.stringify(option.value)).join(', ')}`
    case 'model':
      return 'a model id in quotes, or "" for the Solus default'
  }
}

type ProblemWords = Omit<ConfigProblem, 'line' | 'from' | 'to'>
/** A value the field takes, or why it is not one, with a quick fix when one is plain. */
type CheckedValue = { value: AppConfigValue } | { problem: ProblemWords }

const wrongType = (field: AppConfigField, fix: ConfigFix | null = null): CheckedValue => ({ problem: { title: 'Wrong type.', message: takesText(field), fix } })
const useFix = (value: AppConfigValue): ConfigFix => ({ label: `Use ${JSON.stringify(value)}`, text: JSON.stringify(value) })

function takesText(field: AppConfigField): string {
  return `${field.name} takes ${describeTakes(field)}.`
}

/** Checks one JSON value of the document against its field. */
function checkValue(field: AppConfigField, scanned: ScannedValue): CheckedValue {
  switch (field.type) {
    case 'number':
      return checkNumber(field, scanned)
    case 'boolean':
      if (scanned.kind === 'boolean') return { value: scanned.value }
      return wrongType(field, scanned.kind === 'text' && (scanned.text === 'true' || scanned.text === 'false') ? useFix(scanned.text === 'true') : null)
    case 'choice':
      return checkChoice(field, scanned)
    case 'text':
    case 'model':
      if (scanned.kind !== 'text') return wrongType(field, scanned.kind === 'number' ? useFix(String(scanned.number)) : scanned.kind === 'boolean' ? useFix(String(scanned.value)) : null)
      return checkedByContract(field, scanned.text)
  }
}

/** A number: of the right kind, whole when the field says so, and in its range. The fix is the nearest value it takes. */
function checkNumber(field: Extract<AppConfigField, { type: 'number' }>, scanned: ScannedValue): CheckedValue {
  const given = scanned.kind === 'number' ? scanned.number : scanned.kind === 'text' && scanned.text.trim() !== '' && Number.isFinite(Number(scanned.text)) ? Number(scanned.text) : null
  if (given === null) return wrongType(field)
  const whole = field.integer ? Math.round(given) : given
  const nearest = Math.min(field.max ?? Infinity, Math.max(field.min ?? -Infinity, whole))
  const fix = { label: `Use ${nearest}`, text: JSON.stringify(nearest) }
  if (scanned.kind !== 'number') return wrongType(field, fix)
  if (nearest !== whole) return { problem: { title: 'Out of range.', message: takesText(field), fix } }
  if (whole !== given) return { problem: { title: 'Not a whole number.', message: takesText(field), fix } }
  return checkedByContract(field, given)
}

/** A choice: one of the option values. A label, or a value in another case, is fixed to its value. */
function checkChoice(field: Extract<AppConfigField, { type: 'choice' }>, scanned: ScannedValue): CheckedValue {
  if (scanned.kind !== 'text') return wrongType(field)
  if (field.options.some((option) => option.value === scanned.text)) return checkedByContract(field, scanned.text)
  const typed = scanned.text.toLowerCase()
  const match = field.options.find((option) => option.value.toLowerCase() === typed || option.label.toLowerCase() === typed)
  return { problem: { title: 'Not an option.', message: takesText(field), fix: match ? useFix(match.value) : null } }
}

/** The contract's own rule is the last word, as the host checks it. */
function checkedByContract(field: AppConfigField, value: AppConfigValue): CheckedValue {
  const problem = appConfigValueProblem(field, value)
  return problem ? { problem: { title: 'Not a value of this setting.', message: problem, fix: null } } : { value }
}

// ─── The scanner of one flat JSON object ───

/** One JSON value of the document, as the scanner read it. A nested object or array is one value that no field takes. */
type ScannedValue =
  | { kind: 'text'; text: string }
  | { kind: 'number'; number: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'nested' }

interface ScannedPair {
  key: string
  keyFrom: number
  keyTo: number
  value: ScannedValue
  valueFrom: number
  valueTo: number
}

type Scan = { pairs: ScannedPair[] } | { error: { message: string; at: number } }

/**
 * Reads `{ "key": value, ... }` and where each key and value is. A nested
 * object or array is read whole as one value, which no field takes.
 */
function scanFlatObject(text: string): Scan {
  let at = 0
  const fail = (message: string, where = at): Scan => ({ error: { message, at: Math.min(where, Math.max(0, text.length - 1)) } })
  const skipSpace = () => {
    while (at < text.length && /\s/.test(text[at]!)) at++
  }
  const readString = (): { value: string; to: number } | null => {
    const from = at
    if (text[at] !== '"') return null
    at++
    while (at < text.length && text[at] !== '"') {
      if (text[at] === '\n') return null
      at += text[at] === '\\' ? 2 : 1
    }
    if (at >= text.length) return null
    at++
    const decoded = jsonString(text.slice(from, at))
    return decoded === null ? null : { value: decoded, to: at }
  }
  const readValue = (): { value: ScannedValue; from: number; to: number } | null => {
    const from = at
    const char = text[at]
    if (char === '"') {
      const read = readString()
      return read ? { value: { kind: 'text', text: read.value }, from, to: read.to } : null
    }
    if (char === '{' || char === '[') {
      // A nested value: read to its matching close, strings and all.
      let depth = 0
      while (at < text.length) {
        const current = text[at]!
        if (current === '"') {
          if (!readString()) return null
          continue
        }
        if (current === '{' || current === '[') depth++
        if (current === '}' || current === ']') depth--
        at++
        if (depth === 0) break
      }
      if (depth !== 0 || !isJson(text.slice(from, at))) return null
      return { value: { kind: 'nested' }, from, to: at }
    }
    const match = /^(?:(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false)|null)/.exec(text.slice(at))
    if (!match) return null
    at += match[0].length
    const value: ScannedValue = match[1] ? { kind: 'number', number: Number(match[1]) } : match[2] ? { kind: 'boolean', value: match[2] === 'true' } : { kind: 'null' }
    return { value, from, to: at }
  }

  skipSpace()
  if (text[at] !== '{') return fail('The config is one object: it starts with {.')
  at++
  const pairs: ScannedPair[] = []
  skipSpace()
  if (text[at] === '}') at++
  else {
    for (;;) {
      skipSpace()
      const keyFrom = at
      const key = readString()
      if (!key) return fail('A setting starts with its name in double quotes.', keyFrom)
      skipSpace()
      if (text[at] !== ':') return fail(`Put a colon after "${key.value}".`)
      at++
      skipSpace()
      const value = readValue()
      if (!value) return fail(`The value of "${key.value}" is not a JSON value.`)
      pairs.push({ key: key.value, keyFrom, keyTo: key.to, value: value.value, valueFrom: value.from, valueTo: value.to })
      skipSpace()
      if (text[at] === ',') {
        at++
        continue
      }
      if (text[at] === '}') {
        at++
        break
      }
      return fail('Put a comma between two settings, or } at the end.')
    }
  }
  skipSpace()
  if (at < text.length) return fail('Nothing comes after the closing }.')
  return { pairs }
}

const jsonStringSchema = z.string()

/** Whether `text` is one JSON value. */
function isJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** The string a JSON string literal stands for, or null when `text` is not one. */
function jsonString(text: string): string | null {
  if (!isJson(text)) return null
  const decoded = jsonStringSchema.safeParse(JSON.parse(text))
  return decoded.success ? decoded.data : null
}

/** The line, from 1, of each offset. */
function lineFinder(text: string): (offset: number) => number {
  const starts = [0]
  for (let index = 0; index < text.length; index++) if (text[index] === '\n') starts.push(index + 1)
  return (offset) => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (starts[middle]! <= offset) low = middle
      else high = middle - 1
    }
    return low + 1
  }
}

import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import { z } from 'zod'
import type { CodeProblem } from './code-marks'

/**
 * What the shared code editor knows of JSON against a JSON schema: where the
 * cursor is in the document, the fields and values to complete there, and
 * the problems of a document that parses. Pure, so the rules are tested
 * without an editor.
 *
 * The schema is the part of JSON Schema the page reads; a part of another
 * shape reads as absent.
 */

type SchemaValue = string | number | boolean | null

export interface JsonSchemaNode {
  type?: string[]
  enum?: SchemaValue[]
  const?: SchemaValue
  description?: string
  default?: unknown
  properties?: { [name: string]: JsonSchemaNode }
  required?: string[]
  items?: JsonSchemaNode
  anyOf?: JsonSchemaNode[]
  oneOf?: JsonSchemaNode[]
}

// ─── Where the cursor is ───

/** A step of a path in the document: the key of an object, or `*` for an item of an array. */
export type JsonPathStep = string

export interface JsonCursor {
  /** The keys from the top object to the container the cursor is in. */
  path: JsonPathStep[]
  /** A key of an object, or a value. */
  slot: 'key' | 'value'
  /** Where the word at the cursor starts: after its opening quote, or the cursor. */
  from: number
  /** What the reader typed of the word, without its quote. */
  typed: string
  /** The word is in a string the reader opened. */
  isQuoted: boolean
  /** The keys the object at the cursor already has. */
  keys: string[]
}

interface Frame {
  kind: 'object' | 'array'
  /** The key or `*` of this container in its parent. */
  step: JsonPathStep
  expects: 'key' | 'colon' | 'value' | 'comma'
  key: string | null
  keys: string[]
}

/** A read of JSON up to the cursor: the containers it is in, from the top one. */
class JsonScan {
  readonly stack: Frame[] = []
  constructor(private readonly text: string, private readonly at: number) {}

  private get top(): Frame | undefined {
    return this.stack[this.stack.length - 1]
  }

  /** The cursor in a word that starts at `from`: a key, or a value. */
  wordAt(from: number, isQuoted: boolean): JsonCursor | null {
    const frame = this.top
    if (!frame) return null
    const word = { from, typed: this.text.slice(from, this.at), isQuoted }
    if (frame.kind === 'object' && frame.expects === 'key') return { path: this.path(), slot: 'key', ...word, keys: frame.keys }
    if (frame.expects === 'value') return { path: [...this.path(), frame.kind === 'object' ? (frame.key ?? '') : '*'], slot: 'value', ...word, keys: [] }
    return null
  }

  private path(): JsonPathStep[] {
    return this.stack.slice(1).map((frame) => frame.step)
  }

  /** A string closed before the cursor: a key, or a value that is done. */
  closeString(content: string): void {
    const frame = this.top
    if (frame?.kind === 'object' && frame.expects === 'key') {
      frame.key = content
      frame.keys.push(content)
      frame.expects = 'colon'
    } else this.valueDone()
  }

  valueDone(): void {
    const frame = this.top
    if (frame) frame.expects = 'comma'
  }

  open(kind: Frame['kind']): void {
    const parent = this.top
    const step = parent ? (parent.kind === 'object' ? (parent.key ?? '') : '*') : ''
    this.stack.push({ kind, step, expects: kind === 'object' ? 'key' : 'value', key: null, keys: [] })
  }

  close(): void {
    this.stack.pop()
    this.valueDone()
  }

  colon(): void {
    const frame = this.top
    if (frame) frame.expects = 'value'
  }

  comma(): void {
    const frame = this.top
    if (!frame) return
    frame.expects = frame.kind === 'object' ? 'key' : 'value'
    frame.key = null
  }
}

/** A string of the document: where it ends, its content, and whether it closed before the text ends. */
interface JsonStringRead {
  end: number
  content: string
  closed: boolean
}

function readJsonString(text: string, start: number): JsonStringRead {
  let index = start + 1
  while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1
  const closed = index < text.length
  return { end: closed ? index + 1 : text.length, content: text.slice(start + 1, Math.min(index, text.length)), closed }
}

const BARE_WORD = /[\w.+-]/

/**
 * Where `at` is in a JSON document that may not parse yet: the reader is
 * typing it. Null where nothing completes: between a key and its colon, or
 * after a value before its comma.
 */
export function jsonCursorAt(text: string, at: number): JsonCursor | null {
  const scan = new JsonScan(text, at)
  let index = 0
  while (index < at) {
    const char = text[index]
    if (char === '"') {
      const string = readJsonString(text, index)
      // The cursor is in this string.
      if (!string.closed || string.end - 1 >= at) return scan.wordAt(index + 1, true)
      scan.closeString(string.content)
      index = string.end
      continue
    }
    if (BARE_WORD.test(char)) {
      // A bare word: a number, true, false, or null.
      const start = index
      while (index < text.length && BARE_WORD.test(text[index])) index++
      if (index >= at) return scan.wordAt(start, false)
      scan.valueDone()
      continue
    }
    if (char === '{') scan.open('object')
    else if (char === '[') scan.open('array')
    else if (char === '}' || char === ']') scan.close()
    else if (char === ':') scan.colon()
    else if (char === ',') scan.comma()
    index++
  }
  return scan.wordAt(at, false)
}

// ─── The schema at a path ───

function typesOf(node: JsonSchemaNode): string[] {
  if (node.type) return node.type
  const options = node.anyOf ?? node.oneOf
  return options ? [...new Set(options.flatMap(typesOf))] : []
}

/** The schema of the value at a path; null where the schema says nothing. */
export function schemaAt(schema: JsonSchemaNode, path: readonly JsonPathStep[]): JsonSchemaNode | null {
  let node: JsonSchemaNode | null = schema
  for (const step of path) {
    if (!node) return null
    const options: JsonSchemaNode[] = [node, ...(node.anyOf ?? node.oneOf ?? [])]
    node = step === '*' ? (options.find((option) => option.items)?.items ?? null) : (options.find((option) => option.properties?.[step])?.properties?.[step] ?? null)
  }
  return node
}

function propertiesOf(node: JsonSchemaNode): { [name: string]: JsonSchemaNode } {
  return Object.assign({}, ...[node, ...(node.anyOf ?? node.oneOf ?? [])].map((option) => option.properties ?? {}))
}

const TYPE_WORDS = { string: 'text', number: 'number', integer: 'whole number', boolean: 'boolean', object: 'object', array: 'list', null: 'null' }

function isWordedType(type: string): type is keyof typeof TYPE_WORDS {
  return type in TYPE_WORDS
}

/** "text", "whole number", "boolean": a type in the words of the Operations section. */
function typeWords(node: JsonSchemaNode): string {
  if (node.enum) return 'choice'
  const types = typesOf(node)
  return types.length === 0 ? 'any value' : types.map((type) => (isWordedType(type) ? TYPE_WORDS[type] : type)).join(' or ')
}

// ─── Completion ───

/**
 * The fields and values to offer at the cursor, from the schema. In a string
 * the reader opened, the menu matches what follows the quote, and a choice
 * takes the closing quote with it.
 */
export function jsonSchemaCompletions(text: string, at: number, schema: JsonSchemaNode): { from: number; to: number; options: Completion[] } | null {
  const cursor = jsonCursorAt(text, at)
  if (!cursor) return null
  const to = cursor.isQuoted && text[at] === '"' ? at + 1 : at
  if (cursor.slot === 'key') {
    const container = schemaAt(schema, cursor.path)
    if (!container) return null
    const required = new Set([container, ...(container.anyOf ?? container.oneOf ?? [])].flatMap((option) => option.required ?? []))
    const options = Object.entries(propertiesOf(container))
      .filter(([name]) => !cursor.keys.includes(name) || name === cursor.typed)
      .map(([name, property]): Completion => ({
        label: name,
        apply: cursor.isQuoted ? `${JSON.stringify(name).slice(1)}: ` : `${JSON.stringify(name)}: `,
        type: 'property',
        detail: `${typeWords(property)}${required.has(name) ? ' · required' : ''}`,
        info: fieldInfo(property, required.has(name)) ?? undefined,
        boost: required.has(name) ? 1 : 0,
      }))
    return options.length === 0 ? null : { from: cursor.from, to, options }
  }
  const node = schemaAt(schema, cursor.path)
  if (!node) return null
  const values: SchemaValue[] = node.enum ?? (node.const !== undefined ? [node.const] : [])
  const types = typesOf(node)
  if (values.length === 0 && types.includes('boolean')) values.push(true, false)
  if (types.includes('null')) values.push(null)
  // In a string, only text completes.
  const offered = cursor.isQuoted ? values.filter((value) => JSON_KINDS.string.safeParse(value).success) : values
  if (offered.length === 0) return null
  const options = offered.map((value): Completion => {
    const json = JSON.stringify(value)
    return cursor.isQuoted ? { label: json.slice(1, -1), apply: json.slice(1), type: 'constant', detail: typeWords(node) } : { label: json, type: 'constant', detail: typeWords(node) }
  })
  return { from: cursor.from, to, options }
}

/** The words beside a field in the menu: "Watch betas too. Optional, default false." */
function fieldInfo(node: JsonSchemaNode, isRequired: boolean): string | null {
  const parts = [node.description?.trim()].filter((part): part is string => Boolean(part))
  const facts = [isRequired ? 'Required' : 'Optional']
  if (node.default !== undefined) facts.push(`default ${JSON.stringify(node.default)}`)
  parts.push(`${facts.join(', ')}.`)
  return parts.join(' ')
}

/** The completion source of an editor whose text a schema describes. */
export function jsonSchemaCompletionSource(schema: () => JsonSchemaNode | null): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const current = schema()
    if (!current) return null
    const text = context.state.doc.toString()
    const found = jsonSchemaCompletions(text, context.pos, current)
    if (!found) return null
    // With nothing typed, the menu opens only on request (Ctrl-Space) or after a quote.
    if (!context.explicit && found.from === context.pos && text[context.pos - 1] !== '"') return null
    return { from: found.from, to: found.to, options: found.options, validFor: /^[\w.-]*$/ }
  }
}

// ─── Problems ───

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** Each JSON Schema type as a check of a parsed value. */
const JSON_KINDS = {
  string: z.string(),
  number: z.number(),
  integer: z.number().int(),
  boolean: z.boolean(),
  null: z.null(),
  array: z.array(z.json()),
  object: z.record(z.string(), z.json()),
}

function isJsonKind(type: string): type is keyof typeof JSON_KINDS {
  return type in JSON_KINDS
}

/** One key of an object in a document that parses, with where its key and its value are. */
interface JsonEntry {
  path: JsonPathStep[]
  key: string
  keyFrom: number
  keyTo: number
  valueFrom: number
  valueTo: number
  value: JsonValue
}

/** Every key of every object in valid JSON, with its place. Null when the text does not parse. */
export function jsonEntries(text: string): { root: JsonValue; entries: JsonEntry[]; objects: { path: JsonPathStep[]; from: number }[] } | null {
  let root: JsonValue
  try {
    root = JSON.parse(text)
  } catch {
    return null
  }
  const entries: JsonEntry[] = []
  const objects: { path: JsonPathStep[]; from: number }[] = []
  let index = 0
  const space = () => {
    while (/\s/.test(text[index] ?? '')) index++
  }
  const readString = (): string => {
    const start = index
    index++
    while (text[index] !== '"') index += text[index] === '\\' ? 2 : 1
    index++
    return JSON.parse(text.slice(start, index))
  }
  const readValue = (path: JsonPathStep[]): JsonValue => {
    space()
    const char = text[index]
    if (char === '{') {
      objects.push({ path, from: index })
      index++
      const value: { [key: string]: JsonValue } = {}
      space()
      if (text[index] === '}') {
        index++
        return value
      }
      for (;;) {
        space()
        const keyFrom = index
        const key = readString()
        const keyTo = index
        space()
        index++ // :
        space()
        const valueFrom = index
        const item = readValue([...path, key])
        entries.push({ path, key, keyFrom, keyTo, valueFrom, valueTo: index, value: item })
        value[key] = item
        space()
        if (text[index++] === '}') return value
      }
    }
    if (char === '[') {
      index++
      const value: JsonValue[] = []
      space()
      if (text[index] === ']') {
        index++
        return value
      }
      for (;;) {
        value.push(readValue([...path, '*']))
        space()
        if (text[index++] === ']') return value
      }
    }
    if (char === '"') return readString()
    const start = index
    while (index < text.length && /[\w.+-]/.test(text[index])) index++
    return JSON.parse(text.slice(start, index))
  }
  readValue([])
  return { root, entries, objects }
}

function lineAt(text: string, at: number): number {
  let line = 1
  for (let index = 0; index < at && index < text.length; index++) if (text[index] === '\n') line++
  return line
}

/** Whether a value has a type the schema names. A type the page does not know passes. */
function hasType(value: JsonValue, types: readonly string[]): boolean {
  if (types.length === 0) return true
  return types.some((type) => !isJsonKind(type) || JSON_KINDS[type].safeParse(value).success)
}

/** The value a wrong one plainly means: `"14"` for a number is 14, `"true"` for a boolean is true. */
function plainValue(value: JsonValue, types: readonly string[]): JsonValue | undefined {
  const text = JSON_KINDS.string.safeParse(value)
  if (text.success) {
    const trimmed = text.data.trim()
    if ((types.includes('number') || types.includes('integer')) && trimmed !== '' && Number.isFinite(Number(trimmed))) {
      const number = Number(trimmed)
      if (hasType(number, types)) return number
    }
    if (types.includes('boolean') && (trimmed === 'true' || trimmed === 'false')) return trimmed === 'true'
    return undefined
  }
  const scalar = z.union([z.number(), z.boolean()]).safeParse(value)
  if (types.includes('string') && scalar.success) return String(scalar.data)
  return undefined
}

/** The field a name was meant to be: one letter or two away, or the same in another case. */
function closestName(name: string, names: readonly string[]): string | null {
  const lower = name.toLowerCase()
  let best: { name: string; distance: number } | null = null
  for (const candidate of names) {
    const distance = candidate.toLowerCase() === lower ? 0 : editDistance(lower, candidate.toLowerCase())
    if (distance <= 2 && (!best || distance < best.distance)) best = { name: candidate, distance }
  }
  return best?.name ?? null
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return row[b.length]
}

/**
 * The problems of a document against its schema: a field the schema does
 * not declare, a value of the wrong type or not one of its choices, and a
 * required field that is absent. A document that does not parse has no
 * problem here: the reader is still typing it, and Run says why it is not
 * JSON.
 */
export function jsonSchemaProblems(text: string, schema: JsonSchemaNode): CodeProblem[] {
  const parsed = jsonEntries(text)
  if (!parsed) return []
  const problems: CodeProblem[] = []
  for (const entry of parsed.entries) {
    const container = schemaAt(schema, entry.path)
    if (!container) continue
    const properties = propertiesOf(container)
    const names = Object.keys(properties)
    const node = properties[entry.key]
    const line = lineAt(text, entry.keyFrom)
    if (!node) {
      if (names.length === 0) continue
      const meant = closestName(entry.key, names)
      problems.push({
        title: 'Unknown field.',
        message: `It takes no field named ${entry.key}.`,
        line,
        from: entry.keyFrom,
        to: entry.keyTo,
        fix: meant ? { label: `Use ${meant}`, insert: JSON.stringify(meant) } : null,
      })
      continue
    }
    if (node.enum && !node.enum.some((choice) => choice === entry.value)) {
      problems.push({ title: 'Not a choice.', message: `${entry.key} takes one of ${node.enum.map((choice) => JSON.stringify(choice)).join(', ')}.`, line, from: entry.valueFrom, to: entry.valueTo, fix: null })
      continue
    }
    const types = typesOf(node)
    if (!hasType(entry.value, types)) {
      const plain = plainValue(entry.value, types)
      problems.push({
        title: 'Wrong type.',
        message: `${entry.key} takes ${typeWords(node)}.`,
        line,
        from: entry.valueFrom,
        to: entry.valueTo,
        fix: plain === undefined ? null : { label: `Use ${JSON.stringify(plain)}`, insert: JSON.stringify(plain) },
      })
    }
  }
  for (const object of parsed.objects) {
    const node = schemaAt(schema, object.path)
    if (!node?.required) continue
    const given = new Set(parsed.entries.filter((entry) => entry.path.join('\u0000') === object.path.join('\u0000') && entry.path.length === object.path.length).map((entry) => entry.key))
    const absent = node.required.filter((name) => !given.has(name))
    if (absent.length === 0) continue
    problems.push({
      title: absent.length === 1 ? 'A required field is absent.' : 'Required fields are absent.',
      message: `Add ${absent.join(', ')}.`,
      line: lineAt(text, object.from),
      from: object.from,
      to: object.from + 1,
      fix: null,
    })
  }
  return problems.sort((a, b) => a.line - b.line)
}

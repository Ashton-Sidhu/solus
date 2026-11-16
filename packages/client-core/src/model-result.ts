import { z } from 'zod'
import type { AppModelCallView } from '@solus/contracts/app-models'

/**
 * A model call's result as a person reads it (docs/plans/app-models.md §7):
 * the app's typed output laid out as labelled fields instead of raw JSON.
 * Desktop, web, and mobile draw the same tree.
 */

type ResultValue = AppModelCallView['result']

export type ResultNode =
  /** Prose: a long or multi-line string. */
  | { kind: 'text'; text: string }
  /** A value short enough to sit beside its label: a number, a flag, a word or two. */
  | { kind: 'short'; text: string }
  /** A list of short values. */
  | { kind: 'tags'; items: string[] }
  /** A list of anything else. */
  | { kind: 'items'; items: ResultNode[] }
  /** An object: its title, its short fields in one line, then its other fields. */
  | { kind: 'record'; title: string | null; facts: ResultFact[]; fields: ResultField[] }
  /** Data nested too deep to lay out. */
  | { kind: 'json'; text: string }

export interface ResultField {
  label: string
  node: ResultNode
}

export interface ResultFact {
  label: string
  text: string
}

const SHORT_TEXT_MAX = 48
const TITLE_MAX = 120
const TITLE_KEYS = ['title', 'name', 'label', 'heading']
const MAX_DEPTH = 4

const titleSchema = z.string().min(1).max(TITLE_MAX)
const listSchema = z.array(z.json())
const recordSchema = z.record(z.string(), z.json())

export function modelResultTree(value: ResultValue, depth = 0): ResultNode {
  if (value === null) return { kind: 'short', text: '—' }
  const text = z.string().safeParse(value)
  if (text.success) return isShortText(text.data) ? { kind: 'short', text: text.data || '—' } : { kind: 'text', text: text.data }
  const flag = z.boolean().safeParse(value)
  if (flag.success) return { kind: 'short', text: flag.data ? 'Yes' : 'No' }
  const list = listSchema.safeParse(value)
  const record = recordSchema.safeParse(value)
  if (!list.success && !record.success) return { kind: 'short', text: String(value) }
  if (depth >= MAX_DEPTH) return { kind: 'json', text: JSON.stringify(value, null, 2) }
  if (list.success) {
    if (list.data.length === 0) return { kind: 'short', text: 'None' }
    const nodes = list.data.map((item) => modelResultTree(item, depth + 1))
    return nodes.every((node) => node.kind === 'short') ? { kind: 'tags', items: nodes.map((node) => node.text) } : { kind: 'items', items: nodes }
  }
  return recordTree(record.data ?? {}, depth)
}

/** An object: a short title field heads it, short values sit in one line, the rest stack below. */
function recordTree(record: z.infer<typeof recordSchema>, depth: number): ResultNode {
  const entries = Object.entries(record)
  if (entries.length === 0) return { kind: 'short', text: 'None' }
  const titleKey = TITLE_KEYS.find((key) => titleSchema.safeParse(record[key]).success)
  const facts: ResultFact[] = []
  const fields: ResultField[] = []
  for (const [key, item] of entries) {
    if (key === titleKey) continue
    const label = fieldLabel(key)
    const node = modelResultTree(item, depth + 1)
    if (node.kind === 'short') facts.push({ label, text: node.text })
    else fields.push({ label, node })
  }
  return { kind: 'record', title: titleKey ? String(record[titleKey]) : null, facts, fields }
}

/** `expectedImpact`, `expected_impact` → `Expected impact`; an acronym such as `ID` stays. */
export function fieldLabel(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_-]+/).filter(Boolean)
  const text = words.map((word) => (word.length > 1 && word === word.toUpperCase() ? word : word.toLowerCase())).join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function isShortText(text: string): boolean {
  return text.length <= SHORT_TEXT_MAX && !text.includes('\n')
}

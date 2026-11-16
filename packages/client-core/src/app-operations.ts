import { z } from 'zod'
import type { AppJsonSchema, AppOperation } from '@solus/contracts/apps'

/**
 * How the Operations section of an app's Manage page names an operation, on
 * desktop, web, and mobile (docs/plans/apps.md §9.2): what it does to the
 * app's data, what it takes, what it answers, and how long it may take. The
 * schemas become fields a person reads; the raw JSON Schema stays one tap away.
 */

/** "Reads" for a query, which gets a read-only database; "Writes" for a mutation. */
export function operationKindLabel(kind: AppOperation['kind']): string {
  return kind === 'query' ? 'Reads' : 'Writes'
}

/** One property of an object schema, as a person reads it. */
export interface OperationField {
  name: string
  /** "text", "number", "list of text", "one of a, b". */
  type: string
  required: boolean
  description: string | null
}

type SchemaValue = string | number | boolean | null

/** The parts of a JSON Schema the page reads. A part of another shape reads as absent. */
export interface OperationSchemaNode {
  type?: string[]
  enum?: SchemaValue[]
  const?: SchemaValue
  description?: string
  default?: SchemaValue
  properties?: { [name: string]: OperationSchemaNode }
  required?: string[]
  items?: OperationSchemaNode
  anyOf?: OperationSchemaNode[]
  oneOf?: OperationSchemaNode[]
}

const schemaValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
const schemaNodeSchema: z.ZodType<OperationSchemaNode> = z.lazy(() =>
  z.object({
    type: z.union([z.string().transform((type) => [type]), z.array(z.string())]).optional().catch(undefined),
    enum: z.array(schemaValueSchema).optional().catch(undefined),
    const: schemaValueSchema.optional().catch(undefined),
    description: z.string().trim().min(1).optional().catch(undefined),
    default: schemaValueSchema.optional().catch(undefined),
    properties: z.record(z.string(), schemaNodeSchema).optional().catch(undefined),
    required: z.array(z.string()).optional().catch(undefined),
    items: schemaNodeSchema.optional().catch(undefined),
    anyOf: z.array(schemaNodeSchema).optional().catch(undefined),
    oneOf: z.array(schemaNodeSchema).optional().catch(undefined),
  }),
)

/** A schema as the parts the page reads: the editor completes and checks an input with it. */
export function operationSchemaNode(schema: AppJsonSchema): OperationSchemaNode {
  return schemaNodeSchema.catch({}).parse(schema)
}

/**
 * The fields of an object schema, in the order the schema declares them. An
 * empty list is an object with no property: the operation takes nothing, or
 * answers an empty object. Null is a schema that is not an object of named
 * properties; the page shows its JSON instead.
 */
export function operationFields(schema: AppJsonSchema | undefined): OperationField[] | null {
  if (!schema || Object.keys(schema).length === 0) return []
  const node = operationSchemaNode(schema)
  if (!node.properties) return node.type?.includes('object') ? [] : null
  const required = new Set(node.required ?? [])
  return Object.entries(node.properties).map(([name, property]) => ({
    name,
    type: typeText(property),
    required: required.has(name),
    description: property.description ?? null,
  }))
}

/** The input a form starts from: each field the operation takes, with an empty value of its type. */
export function operationInputTemplate(schema: AppJsonSchema): string {
  const entries = Object.entries(operationSchemaNode(schema).properties ?? {}).map(([name, property]) => [name, emptyValue(property)])
  return entries.length === 0 ? '{}' : JSON.stringify(Object.fromEntries(entries), null, 2)
}

/** "60 s", "15 min": how long one call may take. The host stops a call at 60 seconds when the operation declares no limit. */
export function operationTimeLimitText(timeoutSeconds: number | undefined): string {
  const seconds = timeoutSeconds ?? 60
  return seconds >= 120 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`
}

const TYPE_NAMES = {
  string: 'text',
  number: 'number',
  integer: 'whole number',
  boolean: 'yes or no',
  object: 'object',
  null: 'nothing',
} satisfies { [type: string]: string }

function isNamedType(type: string): type is keyof typeof TYPE_NAMES {
  return type in TYPE_NAMES
}

function typeText(node: OperationSchemaNode): string {
  if (node.enum) return `one of ${node.enum.map(String).join(', ')}`
  if (node.const !== undefined) return String(node.const)
  const options = node.anyOf ?? node.oneOf
  if (options) return [...new Set(options.map(typeText))].join(' or ')
  if (!node.type || node.type.length === 0) return 'any value'
  return node.type.map((type) => (type === 'array' ? `list of ${typeText(node.items ?? {})}` : isNamedType(type) ? TYPE_NAMES[type] : type)).join(' or ')
}

type EmptyValue = SchemaValue | [] | { [key: string]: never }

function emptyValue(node: OperationSchemaNode): EmptyValue {
  if (node.enum && node.enum.length > 0) return node.enum[0]
  const type = node.type?.find((entry) => entry !== 'null')
  if (type === 'string') return ''
  if (type === 'number' || type === 'integer') return 0
  if (type === 'boolean') return false
  if (type === 'array') return []
  if (type === 'object') return {}
  return null
}

/** What calls an app's operations, for the line under the section's name. */
export interface OperationCallers {
  hasUi: boolean
  schedules: number
  webhooks: number
  workflows: number
  agentAccess: boolean
}

/** "Its UI, 2 schedules and agents on this host call them." The page says what the operations are for by naming who uses them. */
export function operationCallersText(callers: OperationCallers): string {
  const counted = (count: number, noun: string) => (count === 1 ? `1 ${noun}` : `${count} ${noun}s`)
  const names = [
    ...(callers.hasUi ? ['Its UI'] : []),
    ...(callers.schedules > 0 ? [counted(callers.schedules, 'schedule')] : []),
    ...(callers.webhooks > 0 ? [counted(callers.webhooks, 'webhook')] : []),
    ...(callers.workflows > 0 ? [counted(callers.workflows, 'workflow')] : []),
    ...(callers.agentAccess ? ['agents on this host'] : []),
  ]
  if (names.length === 0) return 'Nothing calls them yet.'
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  // One caller that is one thing takes "calls": "Its UI calls them", "1 schedule calls them".
  const isOneThing = names.length === 1 && (callers.hasUi || list.startsWith('1 '))
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} ${isOneThing ? 'calls' : 'call'} them.`
}

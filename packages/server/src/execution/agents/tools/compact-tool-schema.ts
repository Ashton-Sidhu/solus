import { z } from 'zod'
import type { AgentTool } from './agent-tool'

type JsonSchema = z.core.JSONSchema.JSONSchema

const NULL_SCHEMA = '{"type":"null"}'

/** `true` or `{}`: a schema every value meets, which says nothing an absent keyword does not. */
function acceptsAnything(schema: JsonSchema['additionalProperties']): boolean {
  return schema === true || JSON.stringify(schema) === '{}'
}

/**
 * An optional field may be left out, so its `null` branch only repeats what
 * leaving it out says. The call is still parsed against the full schema, so a
 * `null` the model does send is accepted as before.
 */
function dropNullBranch(jsonSchema: JsonSchema): void {
  const branches = jsonSchema.anyOf
  if (!branches?.some((branch) => JSON.stringify(branch) === NULL_SCHEMA)) return
  // A new list: the array may be shared with the nullable schema this one wraps.
  const kept = branches.filter((branch) => JSON.stringify(branch) !== NULL_SCHEMA)
  delete jsonSchema.anyOf
  if (kept.length > 1) {
    jsonSchema.anyOf = kept
    return
  }
  // The one branch left becomes the node; the node's own keys, such as its description, win.
  const own = { ...jsonSchema }
  Object.assign(jsonSchema, kept[0], own)
}

/**
 * Remove from one schema node what costs context on every turn and constrains
 * nothing: `default`, an `additionalProperties` or `propertyNames` that allows
 * every value, safe-integer bounds, and the `null` branch of an optional
 * field. Descriptions, enums, `required` lists, and real bounds stay.
 */
function compactNode(jsonSchema: JsonSchema, optional: boolean): void {
  delete jsonSchema.default
  if (acceptsAnything(jsonSchema.additionalProperties)) delete jsonSchema.additionalProperties
  // Every JSON object key is a string.
  if (JSON.stringify(jsonSchema.propertyNames) === '{"type":"string"}') delete jsonSchema.propertyNames
  if (jsonSchema.maximum === Number.MAX_SAFE_INTEGER) delete jsonSchema.maximum
  if (jsonSchema.minimum === Number.MIN_SAFE_INTEGER) delete jsonSchema.minimum
  if (optional) dropNullBranch(jsonSchema)
}

/**
 * The input schema a model reads for a tool with these fields: the input side
 * (a field with a default may be left out), compact, and without `$schema`.
 * Calls are parsed against the full fields, so every input that parsed before
 * still parses.
 */
export function compactToolSchema(fields: AgentTool['inputFields']): JsonSchema {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(z.object(fields), {
    io: 'input',
    override: ({ zodSchema, jsonSchema }) => compactNode(jsonSchema, zodSchema._zod.optin === 'optional'),
  })
  return schema
}

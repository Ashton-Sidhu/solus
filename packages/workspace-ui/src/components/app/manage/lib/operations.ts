import { z } from 'zod'
import { appOperationCallName, type AppJsonSchema } from '@solus/contracts/apps'
import { appCallValue, type AppCallValue } from '@solus/client-core/app-calls'
import type { AppHostCall } from '@solus/client-core/app-files'
import type { DraftResult } from '../../../webhooks/lib/webhook-draft'

/** The Operations section (docs/plans/apps.md §9.2): the form that runs one operation with a JSON input. */

const inputSchema = z.record(z.string(), z.json())

/** The input a form sends, from what the person typed: a JSON object. Nothing typed is an empty object. */
export function operationInput(text: string): DraftResult<string> {
  if (!text.trim()) return { ok: true, value: '{}' }
  let parsed: AppCallValue
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, error: `The input is not JSON: ${error instanceof Error ? error.message : 'it does not parse'}.` }
  }
  const input = inputSchema.safeParse(parsed)
  if (!input.success) return { ok: false, error: 'The input must be a JSON object.' }
  return { ok: true, value: JSON.stringify(input.data) }
}

/** Runs one operation as the UI does, and answers its value. The call is in the call log with the caller `ui`. */
export async function runOperation(call: AppHostCall, operation: string, inputJson: string): Promise<AppCallValue> {
  return appCallValue(await call(appOperationCallName(operation), inputJson))
}

/** A schema or a value as the page shows it. */
export function jsonText(value: AppJsonSchema | AppCallValue): string {
  return JSON.stringify(value, null, 2)
}

/** Whether a schema says something: a build writes `{}` for an operation that takes no input. */
export function hasSchema(schema: AppJsonSchema | undefined): schema is AppJsonSchema {
  return schema !== undefined && Object.keys(schema).length > 0
}

import { z } from 'zod'
import type { McpAppToolInfo } from '@solus/contracts/mcp-apps'

/**
 * The host side of an app frame's bridge (docs/plans/apps.md §4), shared by
 * desktop, web, and mobile. An app's page posts
 * `{ type: "solus-app-call", id, name, args }`; the client that holds the
 * frame answers `{ type: "solus-app-result", id, ok, value | error }`.
 */

const valueSchema = z.json()
export type AppCallValue = z.infer<typeof valueSchema>
const argumentsSchema = z.record(z.string(), valueSchema)
export type AppCallArguments = z.infer<typeof argumentsSchema>

/** One call as the page posts it. A message of any other shape is not a call. */
export const appCallMessageSchema = z.object({
  type: z.literal('solus-app-call'),
  id: z.number(),
  name: z.string().min(1).max(512),
  args: argumentsSchema.catch({}),
})
export type AppCallMessage = z.infer<typeof appCallMessageSchema>

export type AppResultMessage =
  | { type: 'solus-app-result'; id: number; ok: true; value: AppCallValue }
  | { type: 'solus-app-result'; id: number; ok: false; error: string }

/** What a client gives the relay: the app's two host calls, and its own approval prompt. */
export interface AppCallHost {
  toolInfo(name: string): Promise<McpAppToolInfo>
  callTool(name: string, argumentsJson: string, approved: boolean): Promise<string>
  confirm(title: string, detail: string): Promise<boolean>
}

/** A tool result as the host answers it: an integration's own result, or `{ value }` for the app's storage and host functions. */
const callResultSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  structuredContent: valueSchema.optional(),
  isError: z.boolean().optional(),
})
const hostValueSchema = z.object({ value: valueSchema })

/**
 * The value a page gets for a call. The host wraps a storage or host function
 * answer as `{ value }`, because a tool result's structured content is always
 * an object. An integration tool answers its structured content, else its
 * text parsed as JSON, else the text.
 */
export function appCallValue(name: string, resultJson: string): AppCallValue {
  const result = callResultSchema.parse(JSON.parse(resultJson))
  const text = (result.content ?? []).filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n')
  if (result.isError) throw new Error(text || 'The call failed.')
  if (name.startsWith('@')) return hostValueSchema.parse(result.structuredContent).value
  if (result.structuredContent !== undefined) return result.structuredContent
  if (!text) return null
  try {
    return valueSchema.parse(JSON.parse(text))
  } catch {
    return text
  }
}

/**
 * Answers one call of an app's page: asks the host whether it may run, asks
 * the person before a call that is not read-only, runs it, and gives the page
 * its value. Every refusal is the rejected promise's message, which the page
 * shows.
 */
export async function answerAppCall(host: AppCallHost, name: string, args: AppCallArguments): Promise<AppCallValue> {
  const tool = await host.toolInfo(name)
  if (!tool.callable) throw new Error(tool.refusal ?? 'This app cannot make that call.')
  const argumentsJson = JSON.stringify(args)
  if (!tool.readOnly && !(await host.confirm(`Allow ${tool.title}?`, argumentsJson))) throw new Error('Declined by the user.')
  return appCallValue(name, await host.callTool(name, argumentsJson, !tool.readOnly))
}

/** The message a client posts back to the page for a call it answered. */
export async function appResultMessage(id: number, answer: Promise<AppCallValue>): Promise<AppResultMessage> {
  return answer.then(
    (value): AppResultMessage => ({ type: 'solus-app-result', id, ok: true, value }),
    (error): AppResultMessage => ({ type: 'solus-app-result', id, ok: false, error: error instanceof Error ? error.message : 'The call failed.' }),
  )
}

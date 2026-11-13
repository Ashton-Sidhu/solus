import { z } from 'zod'

/**
 * The host side of an app frame's bridge (docs/plans/apps.md §9), shared by
 * desktop, web, and mobile. An app's UI posts
 * `{ type: "solus-app-call", id, name, args }`; the client that holds the
 * frame answers `{ type: "solus-app-result", id, ok, value | error }`. When
 * the app's data changed outside that UI, the client posts
 * `{ type: "solus-app-event", event: "data-changed" }`.
 */

const valueSchema = z.json()
export type AppCallValue = z.infer<typeof valueSchema>
const argumentsSchema = z.record(z.string(), valueSchema)
export type AppCallArguments = z.infer<typeof argumentsSchema>

/** One call as the UI posts it. A message of any other shape is not a call. */
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

/** What a client posts to an app's UI when a mutation changed the app's data. */
export const APP_DATA_CHANGED_MESSAGE = { type: 'solus-app-event', event: 'data-changed' } as const

/** The host's answer to a call: `{ value }` as JSON text (`appCall`). */
const hostAnswerSchema = z.object({ value: valueSchema })

/** The value a UI gets for a call, from the host's answer. */
export function appCallValue(answerJson: string): AppCallValue {
  return hostAnswerSchema.parse(JSON.parse(answerJson)).value
}

/**
 * Answers one call of an app's UI: runs it on the host and gives the UI its
 * value. An app never asks the person first (decision 11). Every refusal is
 * the rejected promise's message, which the UI shows.
 */
export async function answerAppCall(call: (name: string, argumentsJson: string) => Promise<string>, name: string, args: AppCallArguments): Promise<AppCallValue> {
  return appCallValue(await call(name, JSON.stringify(args)))
}

/** The message a client posts back to the UI for a call it answered. */
export async function appResultMessage(id: number, answer: Promise<AppCallValue>): Promise<AppResultMessage> {
  return answer.then(
    (value): AppResultMessage => ({ type: 'solus-app-result', id, ok: true, value }),
    (error): AppResultMessage => ({ type: 'solus-app-result', id, ok: false, error: error instanceof Error ? error.message : 'The call failed.' }),
  )
}

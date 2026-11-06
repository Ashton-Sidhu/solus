import { drive_v3, type GlobalOptions } from '@googleapis/drive'
import { docs_v1 } from '@googleapis/docs'
import { z } from 'zod'

/**
 * The Google Drive and Docs clients for one access token (plans/032 D7).
 *
 * Requests go through the runtime's own `fetch`, as every other request this
 * host makes does; the SDK would otherwise load `node-fetch`. They are never
 * retried: a Docs write is positional and a comment post is not idempotent, so
 * a replay after a lost answer can apply twice.
 */
function options(accessToken: string, timeoutMs: number | undefined): GlobalOptions {
  const chosen: GlobalOptions = {
    headers: { Authorization: `Bearer ${accessToken}` },
    retry: false,
    // Read at call time, so the fetch a test or the runtime installs is the one used.
    fetchImplementation: (input, init) => globalThis.fetch(input, init),
  }
  if (timeoutMs !== undefined) chosen.timeout = timeoutMs
  return chosen
}

export function driveApi(accessToken: string, timeoutMs?: number): drive_v3.Drive {
  return new drive_v3.Drive(options(accessToken, timeoutMs))
}

export function docsApi(accessToken: string): docs_v1.Docs {
  return new docs_v1.Docs(options(accessToken, undefined))
}

const answeredErrorSchema = z.object({
  status: z.number(),
  response: z.object({ data: z.unknown() }).optional(),
})

/** A call's data; Google's refusal with its status and the start of its body; or no answer (network or timeout). */
export type GoogleAnswer<T> =
  | { kind: 'answered'; data: T }
  | { kind: 'refused'; status: number; body: string }
  | { kind: 'unanswered'; error: Error }

export async function googleAnswer<T>(call: Promise<{ data: T }>): Promise<GoogleAnswer<T>> {
  try {
    return { kind: 'answered', data: (await call).data }
  } catch (error) {
    const answered = answeredErrorSchema.safeParse(error)
    if (!answered.success) return { kind: 'unanswered', error: error instanceof Error ? error : new Error(String(error)) }
    const data = answered.data.response?.data
    const text = z.string().safeParse(data)
    const body = text.success ? text.data : JSON.stringify(data ?? '')
    return { kind: 'refused', status: answered.data.status, body: body.slice(0, 300) }
  }
}

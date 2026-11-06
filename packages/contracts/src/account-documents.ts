/**
 * The documents a person's account keeps for every client of theirs (plans/031
 * D7): one row per document names its route and the schemas its answers decode
 * with. A client reaches any of them through one request shape and one result,
 * so a new document is one row here and a table on the account plane, never a
 * new set of calls on every client.
 */

import { z } from 'zod'
import {
  HOST_LIST_PATH,
  accountHostListConflictBodySchema,
  accountHostListPatchRequestSchema,
  accountHostListResponseSchema,
} from './host-list'

export const ACCOUNT_DOCUMENTS = {
  hosts: {
    path: HOST_LIST_PATH,
    response: accountHostListResponseSchema,
    patch: accountHostListPatchRequestSchema,
    conflict: accountHostListConflictBodySchema,
  },
} as const

export type AccountDocumentName = keyof typeof ACCOUNT_DOCUMENTS
export const accountDocumentNameSchema = z.enum(Object.keys(ACCOUNT_DOCUMENTS) as [AccountDocumentName, ...AccountDocumentName[]])

type Spec<N extends AccountDocumentName> = (typeof ACCOUNT_DOCUMENTS)[N]
export type AccountDocumentResponse<N extends AccountDocumentName> = z.infer<Spec<N>['response']>
export type AccountDocumentPatch<N extends AccountDocumentName> = z.input<Spec<N>['patch']>

/** One call on one document: read it, patch it against the revision it read, or clear it. */
export type AccountDocumentRequest<N extends AccountDocumentName = AccountDocumentName> =
  | { name: N; method: 'GET' | 'DELETE' }
  | { name: N; method: 'PATCH'; body: AccountDocumentPatch<N> }

/** What a call answered. A 409 carries the stored document; a failure says why. */
export type AccountDocumentResult<N extends AccountDocumentName = AccountDocumentName> =
  | { kind: 'ok'; document: AccountDocumentResponse<N> }
  | { kind: 'conflict'; reason: string; current: AccountDocumentResponse<N> }
  | { kind: 'signed-out' }
  | { kind: 'offline' }
  | { kind: 'error'; code: string; message: string | null }

/** A request that crossed a process boundary, checked against the table before it is sent. */
export function parseAccountDocumentRequest(raw: unknown): AccountDocumentRequest | null {
  const head = z.object({ name: accountDocumentNameSchema, method: z.enum(['GET', 'PATCH', 'DELETE']), body: z.unknown().optional() }).safeParse(raw)
  if (!head.success) return null
  const { name, method } = head.data
  if (method !== 'PATCH') return { name, method }
  const body = ACCOUNT_DOCUMENTS[name].patch.safeParse(head.data.body)
  return body.success ? { name, method, body: body.data } : null
}

/**
 * The hosts a person connected to themselves (plans/031 D7): by pairing, SSH, a
 * forward, or an introduction. One list, read from one source: while the person
 * is signed out, the `host_list` table of the host the client runs beside (the
 * desktop's own host, or the host that served a web page; a phone keeps it on the
 * device); while signed in, their account document, which every client syncs.
 * The account's registered and managed machines come from the directory, and the
 * hosts store joins the two by host id.
 *
 * A listing says what a host is and how to reach it. It never holds a credential:
 * each client keeps its own token for each host it paired.
 */

import { z } from 'zod'
import { hostIdentityKeySchema } from './host-identity'
import { hostRouteSchema } from './host-routes'

export const HOST_LIST_MAX_ENTRIES = 500
export const HOST_LIST_MAX_BYTES = 512 * 1024
export const HOST_LIST_SCHEMA_VERSION = 1

export const hostListingSchema = z.object({
  /** The client's id for the host: its installation id, or its directory id. */
  id: z.string().min(1).max(200),
  label: z.string().max(200),
  /** The person typed `label`; it outranks the name the host reports. */
  hasUserLabel: z.boolean().optional(),
  installationId: z.string().min(1).max(200),
  os: z.enum(['macos', 'windows', 'linux']).optional(),
  routes: z.array(hostRouteSchema).max(32),
  identityKey: hostIdentityKeySchema.optional(),
  lastConnected: z.number().int().nonnegative(),
  // Strict: a listing that carries a token, or any field this shape does not name, is refused, not stripped.
}).strict()
export type HostListing = z.infer<typeof hostListingSchema>

/** The account document: one listing per host id; one host is one conflict unit. */
export const hostListKeySchema = z.string().min(1).max(200)
export const hostListSchema = z.record(hostListKeySchema, hostListingSchema)
export type HostList = z.infer<typeof hostListSchema>

export function hostListByteLength(list: HostList): number {
  return new TextEncoder().encode(JSON.stringify(list)).byteLength
}

/** The account route of the document (`GET`, `PATCH`, `DELETE`), on the account origin. */
export const HOST_LIST_PATH = '/v1/account/hosts'

/** `GET /v1/account/hosts`. `revision` is null before the first write of a generation. */
export const accountHostListResponseSchema = z.object({
  schemaVersion: z.literal(HOST_LIST_SCHEMA_VERSION),
  generation: z.number().int().nonnegative(),
  revision: z.number().int().positive().nullable(),
  hosts: hostListSchema,
  updatedAt: z.number().nullable(),
})
export type AccountHostListResponse = z.infer<typeof accountHostListResponseSchema>

/** `PATCH /v1/account/hosts`: `set` replaces each host it carries, `reset` removes hosts. */
export const accountHostListPatchRequestSchema = z.object({
  generation: z.number().int().nonnegative(),
  expectedRevision: z.number().int().positive().nullable(),
  set: hostListSchema,
  reset: z.array(hostListKeySchema).max(HOST_LIST_MAX_ENTRIES).default([]),
}).strict()
export type AccountHostListPatchRequest = z.input<typeof accountHostListPatchRequestSchema>

/** A 409 on a write: a stale revision or a cleared generation. */
export const accountHostListConflictBodySchema = z.object({
  error: z.enum(['host_list_conflict', 'host_list_generation_changed']),
  current: accountHostListResponseSchema,
})

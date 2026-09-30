/**
 * Live editing of a work (docs/plans/work-review-and-live-editing.md, phase 3b).
 * The host that stores a work owns its live doc, a Yjs document; clients hold
 * copies and exchange Yjs updates with it through these calls and topics. An
 * update travels as base64 inside the JSON envelope both transports carry.
 */

import { z } from 'zod'
import type { Attribution } from './user'

/**
 * The version of the diagram's live model (`diagram-live.ts`). A client and a
 * host that disagree would drop each other's fields; the host opens such a
 * client read-only. Documents use `DOCUMENT_SCHEMA_VERSION`.
 */
export const DIAGRAM_LIVE_SCHEMA_VERSION = 1

/** The Y.XmlFragment a document's body lives in; Tiptap's default field. */
export const DOCUMENT_LIVE_FIELD = 'default'

/** A Yjs update or state vector on the wire. */
const encoded = (maxLength: number) => z.string().max(maxLength).regex(/^[A-Za-z0-9+/]*={0,2}$/)

/** One push, merged from the edits that waited while the last one was in flight. */
const MAX_UPDATE = 4 * 1024 * 1024

export const workLiveOpenRequestSchema = z.object({
  workId: z.string().min(1),
  /** This client's key for the work, kept with its offline copy: the host
   *  keeps the last push sequence for each key, so a resent push applies once. */
  clientKey: z.string().min(8).max(128),
  schemaVersion: z.number().int().min(0),
  /** What the client already has; the host answers only what it lacks. */
  stateVector: encoded(64 * 1024),
})
export type WorkLiveOpenRequest = z.infer<typeof workLiveOpenRequestSchema>

export type WorkLiveOpenResult =
  | {
      /** `read`: the reader cannot edit (a viewer or a commenter), or the
       *  client's schema differs from the host's (`reason: 'schema'`). */
      mode: 'edit' | 'read'
      reason?: 'role' | 'schema'
      /** The updates the client does not have. */
      update: string
      /** The host's state vector, so the client can send what the host lacks. */
      stateVector: string
      /** The last push sequence the host applied for this client key. */
      lastSeq: number
      /** The cursors and selections of the others in the room. */
      awareness: { clientId: string; update: string }[]
      /** The agent edit lock, when one is held: the work is read-only until it ends. */
      lock: WorkLiveLock | null
    }
  /** Artifacts, slides, and Google-linked works are not edited live. */
  | { mode: 'unsupported' }

export const workLivePushRequestSchema = z.object({
  workId: z.string().min(1),
  clientKey: z.string().min(8).max(128),
  /** Increases by one for each push from this key. */
  seq: z.number().int().min(1),
  update: encoded(MAX_UPDATE),
})
export type WorkLivePushRequest = z.infer<typeof workLivePushRequestSchema>

/**
 * `accepted` and `duplicate` both mean the update is durable on the host: the
 * client drops it from its queue. `locked` is retryable: the agent writes the
 * work; send again after `workLive.state` unlocks it. `not-open` asks the client
 * to open again (the host restarted, or the room closed).
 */
export type WorkLivePushResult =
  | { status: 'accepted' | 'duplicate'; seq: number }
  | { status: 'locked' | 'not-open' | 'read-only' }

export const workLiveAwarenessRequestSchema = z.object({
  workId: z.string().min(1),
  /** A y-protocols awareness update: this client's cursor and selection. */
  update: encoded(64 * 1024),
})
export type WorkLiveAwarenessRequest = z.infer<typeof workLiveAwarenessRequestSchema>

export const workLiveCloseRequestSchema = z.object({ workId: z.string().min(1) })
export type WorkLiveCloseRequest = z.infer<typeof workLiveCloseRequestSchema>

/** `workLive.update`: an update another client in the room pushed, or the host made. */
export interface WorkLiveUpdateEvent {
  workId: string
  update: string
}

/** `workLive.awareness`: a cursor moved, or a client left the room (`update: null`). */
export interface WorkLiveAwarenessEvent {
  workId: string
  clientId: string
  update: string | null
}

/** A writer outside the live doc (an agent's `update_work`, a restore) holds
 *  the work while it checks its version and writes. */
export interface WorkLiveLock {
  by: Attribution | null
}

/** `workLive.state`: the agent edit lock started (`lock`) or ended (`null`). */
export interface WorkLiveStateEvent {
  workId: string
  lock: WorkLiveLock | null
}

const CHUNK = 0x8000

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK))
  }
  return btoa(binary)
}

export function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

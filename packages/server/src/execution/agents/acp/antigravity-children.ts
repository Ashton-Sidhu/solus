/**
 * The calls of agy's subagents, inside their subagent cards
 * (docs/plans/antigravity-provider.md §5.2). agy 1.5.18 sends a child's own
 * tool calls on the parent session, with the child's session id before the
 * call id (`<child id>:call_…`). The launch call names no child, so the child
 * is matched to its launch by the record agy keeps for it: the child's session
 * database names its parent session and the role and prompt it was launched
 * with (`trajectory_metadata_blob`, fields 5 and 8). Read-only, and only a file
 * at its own path in the profile.
 */
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { createLogger } from '../../../logger'
import type { AcpToolCall } from './acp-protocol'
import type { AcpChildCalls } from './acp-turn-normalizer'
import { ANTIGRAVITY_APP_DATA_DIR } from './antigravity-auth'
import { antigravityLaunches } from './antigravity-subagents'
import { AntigravityChildTranscript } from './antigravity-child-transcript'
import { managedPath } from './antigravity-turn-outcome'

const log = createLogger('AntigravityChildren', 'antigravity-children.ts')

const CHILD_CALL = /^([\w-]+):(.+)$/
// The child's metadata: its parent session (field 5), and its launch (field 8: role 2, prompt 3).
const PARENT_FIELD = 5
const LAUNCH_FIELD = 8
const LAUNCH_ROLE = 2
const LAUNCH_PROMPT = 3
const MAX_METADATA_BYTES = 1024 * 1024
const metadataRowSchema = z.object({ data: z.instanceof(Uint8Array) })

/** What a child's record says about it. */
export interface AntigravityChildRecord {
  parentSessionId: string | null
  role: string | null
  prompt: string | null
}

/** The length-delimited fields of one protobuf message, by field number; other wire types are skipped. */
function protobufStrings(bytes: Uint8Array): Map<number, Uint8Array[]> {
  const fields = new Map<number, Uint8Array[]>()
  let at = 0
  const varint = (): number => {
    let value = 0
    for (let shift = 0; at < bytes.length && shift < 50; shift += 7) {
      const byte = bytes[at++]!
      value += (byte & 0x7f) * 2 ** shift
      if (byte < 0x80) return value
    }
    throw new Error('A protobuf varint ran past the message.')
  }
  while (at < bytes.length) {
    const key = varint()
    const wire = key & 7
    if (wire === 0) varint()
    else if (wire === 1) at += 8
    else if (wire === 5) at += 4
    else if (wire === 2) {
      const length = varint()
      if (at + length > bytes.length) throw new Error('A protobuf field ran past the message.')
      const list = fields.get(Math.floor(key / 8)) ?? []
      list.push(bytes.subarray(at, at + length))
      fields.set(Math.floor(key / 8), list)
      at += length
    } else throw new Error(`A protobuf field has wire type ${wire}.`)
  }
  return fields
}

const text = (bytes: Uint8Array | undefined) => bytes ? new TextDecoder().decode(bytes) : null

/** Decodes a child's metadata blob; exported for the test that holds agy's own bytes. */
export function antigravityChildRecord(metadata: Uint8Array): AntigravityChildRecord {
  const fields = protobufStrings(metadata)
  const launch = fields.get(LAUNCH_FIELD)?.[0]
  const launchFields = launch ? protobufStrings(launch) : new Map<number, Uint8Array[]>()
  return {
    parentSessionId: text(fields.get(PARENT_FIELD)?.[0]),
    role: text(launchFields.get(LAUNCH_ROLE)?.[0]),
    prompt: text(launchFields.get(LAUNCH_PROMPT)?.[0]),
  }
}

/** The record of a child session in a profile; null when its file is not at its own path or cannot be read. */
function readChildRecord(storage: string, childId: string): AntigravityChildRecord | null {
  const file = managedPath(storage, ['conversations', `${childId}.db`], 'file')
  if (!file) return null
  try {
    const database = new DatabaseSync(file.path, { readOnly: true })
    try {
      database.exec('PRAGMA busy_timeout = 100')
      const row = metadataRowSchema.safeParse(database.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' AND length(data) <= ?").get(MAX_METADATA_BYTES))
      return row.success ? antigravityChildRecord(row.data.data) : null
    } finally {
      database.close()
    }
  } catch (error) {
    log.warn('antigravity_child_record_unreadable', { childId, error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

interface Launch { cardId: string; role: string; prompt: string }

/**
 * One session's subagent cards and the children that work in them. A child
 * whose record names no launch of this session goes to the newest launch that
 * has no child yet, else to the newest launch.
 */
export class AntigravityChildCalls implements AcpChildCalls {
  private readonly launches: Launch[] = []
  private readonly cardOfChild = new Map<string, string>()

  constructor(
    private readonly threadId: string,
    private readonly readRecord: (childId: string) => AntigravityChildRecord | null,
    readonly transcript?: AntigravityChildTranscript,
  ) {}

  note(toolCall: AcpToolCall): void {
    if (CHILD_CALL.test(toolCall.toolCallId) || this.launches.some((launch) => launch.cardId === toolCall.toolCallId)) return
    const launches = antigravityLaunches(toolCall)
    for (const launch of launches) this.launches.push({ cardId: toolCall.toolCallId, ...launch })
    if (launches.length && /^Run(?:ning)? (?:invoke|start)_subagent\??$/.test(toolCall.title?.trim() ?? '')) {
      this.transcript?.noteLaunch(toolCall.toolCallId, launches.length)
    }
  }

  toolIdOf(call: AcpToolCall): string {
    const childId = CHILD_CALL.exec(call.toolCallId)?.[1]
    return childId && this.transcript ? this.transcript.toolIdOf(childId, call) : call.toolCallId
  }

  parentOf(toolCallId: string): string | null {
    const childId = CHILD_CALL.exec(toolCallId)?.[1]
    if (!childId || this.launches.length === 0) return null
    const known = this.cardOfChild.get(childId) ?? this.transcript?.parentOf(childId)
    if (known) return known
    const record = this.readRecord(childId)
    const card = this.cardFor(record)
    this.cardOfChild.set(childId, card)
    // Only the native child's own record can authorize transcript reads when
    // routing ACP calls had to fall back to the most recent launch.
    if (record?.parentSessionId === this.threadId && record.prompt && this.launches.some((launch) =>
      launch.cardId === card && launch.prompt === record.prompt && (!record.role || launch.role === record.role)
    )) this.transcript?.noteChild(childId, card)
    return card
  }

  private cardFor(record: AntigravityChildRecord | null): string {
    // A child of a child works in its parent's card.
    const parentCard = record?.parentSessionId && record.parentSessionId !== this.threadId ? this.cardOfChild.get(record.parentSessionId) : undefined
    if (parentCard) return parentCard
    const matched = record?.prompt ? this.launches.filter((launch) => launch.prompt === record.prompt && (!record.role || launch.role === record.role)) : []
    const taken = new Set(this.cardOfChild.values())
    return (matched.find((launch) => !taken.has(launch.cardId)) ?? matched.at(-1)
      ?? [...this.launches].reverse().find((launch) => !taken.has(launch.cardId)) ?? this.launches.at(-1)!).cardId
  }
}

/** The child calls of one session, read from the profile it runs in. */
export function antigravityChildCalls(profile: string, threadId: string, retainedStorage?: string): AcpChildCalls {
  const storage = retainedStorage ?? join(profile, ANTIGRAVITY_APP_DATA_DIR)
  return new AntigravityChildCalls(threadId, (childId) => readChildRecord(storage, childId), new AntigravityChildTranscript(storage, threadId))
}

import { readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import type { NormalizedEvent } from '@solus/contracts/types'

/**
 * A replay scenario: recorded Solus events, split into turns. Each prompt plays
 * the next turn and wraps around (docs/replay-provider.md).
 *
 * A scenario file is NDJSON, one entry per line:
 *   {"kind":"scenario","label":"Showcase"}          first line: the model's label
 *   {"kind":"turn"}                                 starts the turn the next prompt plays
 *   {"kind":"event","event":{...},"afterMs":400}    one NormalizedEvent; afterMs is optional
 *
 * The backend owns the turn lifecycle, so a file holds what happens inside a
 * turn only: `session_init`, `task_complete`, errors, and status are refused.
 */

/** The events a scenario may hold. Lifecycle and host-owned events are not here. */
const REPLAYABLE_EVENT_TYPES = [
  'text_chunk',
  'thinking',
  'tool_call',
  'tool_call_update',
  'tool_call_complete',
  'tool_result',
  'subagent_report',
  'subagent_running',
  'assistant_message',
  'background_task_started',
  'background_task_progress',
  'background_task_settled',
  'progress',
  'plan',
  'permission_request',
  'question_request',
  'usage',
  'context_compaction',
] as const satisfies readonly NormalizedEvent['type'][]

/** Whether a scenario may hold an event of this type. */
export function isReplayableEventType(type: NormalizedEvent['type']): boolean {
  return REPLAYABLE_EVENT_TYPES.some((replayable) => replayable === type)
}

const replayEventHeadSchema = z.looseObject({ type: z.enum(REPLAYABLE_EVENT_TYPES) })

/** One recorded event. The schema checks the event's type; its other fields
 *  are the recording's, written by the real normalizers or by hand. */
const replayEventSchema = z.custom<NormalizedEvent>(
  (value) => replayEventHeadSchema.safeParse(value).success,
  { message: `event.type must be one of: ${REPLAYABLE_EVENT_TYPES.join(', ')}` },
)

const entrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('scenario'), label: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('turn') }).strict(),
  z.object({ kind: z.literal('event'), event: replayEventSchema, afterMs: z.number().int().nonnegative().optional() }).strict(),
])

export interface ReplayStep {
  event: NormalizedEvent
  afterMs?: number
}

export interface ReplayScenario {
  /** The file name without `.ndjson`: the model id the picker sends. */
  id: string
  label: string
  turns: ReplayStep[][]
}

/** Parses one scenario file. Throws with the file and line on a bad entry. */
export function parseReplayScenario(id: string, ndjson: string): ReplayScenario {
  let label: string | null = null
  const turns: ReplayStep[][] = []
  const lines = ndjson.split('\n')
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue
    const where = `replay scenario "${id}" line ${index + 1}`
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      throw new Error(`${where} is not JSON`)
    }
    const parsed = entrySchema.safeParse(raw)
    if (!parsed.success) throw new Error(`${where}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`)
    const entry = parsed.data
    if (entry.kind === 'scenario') {
      if (label !== null || turns.length > 0) throw new Error(`${where}: the scenario header must be the first entry`)
      label = entry.label
    } else if (entry.kind === 'turn') {
      turns.push([])
    } else {
      const turn = turns.at(-1)
      if (!turn) throw new Error(`${where}: an event comes before the first turn`)
      turn.push(entry.afterMs === undefined ? { event: entry.event } : { event: entry.event, afterMs: entry.afterMs })
    }
  }
  if (label === null) throw new Error(`replay scenario "${id}" has no scenario header`)
  if (turns.length === 0) throw new Error(`replay scenario "${id}" has no turns`)
  return { id, label, turns }
}

/** Every `*.ndjson` scenario in a folder, sorted by id with `showcase` first. */
export function loadReplayScenarios(directory: string): ReplayScenario[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.ndjson'))
    .map((name) => parseReplayScenario(basename(name, '.ndjson'), readFileSync(join(directory, name), 'utf8')))
    .sort((a, b) => Number(b.id === 'showcase') - Number(a.id === 'showcase') || a.id.localeCompare(b.id))
}

const WORDS_PER_CHUNK = 3

/** Splits text into chunks of about three words. Joined, they are the text. */
export function streamChunks(text: string): string[] {
  const words = text.match(/\S+\s*|\s+/g) ?? []
  const chunks: string[] = []
  for (let index = 0; index < words.length; index += WORDS_PER_CHUNK) {
    chunks.push(words.slice(index, index + WORDS_PER_CHUNK).join(''))
  }
  return chunks.length === 0 ? [text] : chunks
}

/** Fields that name a tool call, task, or request, as they appear in an
 *  event's JSON. Prefixed per play, so a replayed turn adds rows instead of
 *  updating the rows of an earlier play. A JSON string inside the event (a tool
 *  input) escapes its quotes, so its own keys do not match. */
const ID_FIELD_PATTERN = /"(toolId|toolUseId|parentToolUseId|planToolUseId|taskId|questionId)":"(?=[^"])/g

export interface ReplayLive {
  /** The working directory that replaces `<workspace>`. */
  workspace: string
  /** A key unique to this play of the turn. */
  turnKey: string
}

/** A recorded event made live: the workspace path filled in, ids made fresh. */
export function materializeEvent(event: NormalizedEvent, live: ReplayLive): NormalizedEvent {
  const workspace = JSON.stringify(live.workspace).slice(1, -1)
  const text = JSON.stringify(event)
    .replaceAll('<workspace>', workspace)
    .replace(ID_FIELD_PATTERN, `"$1":"${live.turnKey}-`)
  return replayEventSchema.parse(JSON.parse(text))
}

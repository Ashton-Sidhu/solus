import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type { NormalizedEvent } from '@solus/contracts/types'

/**
 * The files that the tools of a turn changed, read from the normalized tool
 * events of both providers (docs/plans/codebases.md §6, the `observed`
 * trigger). Claude names the file in the input of `Edit`, `Write`,
 * `MultiEdit`, and `NotebookEdit`. Codex names each file of a patch in the
 * `changes` of its `Edit` call. A shell command names no file, so a write
 * that a command makes is not seen here.
 */

/** The tools whose input names the file they change. */
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** A turn keeps at most this many paths: the turn end reads the disk for each one. */
const OBSERVED_PATHS_MAX = 32

const writeInputSchema = z.object({
  file_path: z.string().optional(),
  notebook_path: z.string().optional(),
  changes: z.array(z.object({ path: z.string() })).optional(),
})

interface TurnWrites {
  /** The open write calls, by tool id (Codex, and a Claude sub-agent). */
  toolIds: Set<string>
  /** The open write calls of Claude's main thread, by content block index: their input comes with `tool_call_complete`. */
  indexes: Set<number>
  paths: Set<string>
}

export class ObservedWrites {
  private readonly sessions = new Map<string, TurnWrites>()

  /** Read one event of a session. Only the input of a write tool is parsed. */
  observe(sessionId: string, event: NormalizedEvent): void {
    if (event.type === 'tool_call') {
      if (!WRITE_TOOLS.has(event.toolName)) {
        // A new block at this index: an open write call there never got its input.
        this.sessions.get(sessionId)?.indexes.delete(event.index)
        return
      }
      const turn = this.turnOf(sessionId)
      turn.toolIds.add(event.toolId)
      // A call that starts with no input gets it when its content block ends.
      if (event.toolInput) this.read(turn, event.toolInput)
      else turn.indexes.add(event.index)
      return
    }
    if (event.type === 'tool_call_update') {
      const turn = this.sessions.get(sessionId)
      if (turn?.toolIds.has(event.toolId) && event.toolInput && !event.inputPartial) this.read(turn, event.toolInput)
      return
    }
    if (event.type === 'tool_call_complete') {
      const turn = this.sessions.get(sessionId)
      if (turn?.indexes.delete(event.index) && event.toolInput) this.read(turn, event.toolInput)
    }
  }

  /** The absolute paths that the session wrote since the last call. The list is then empty. */
  take(sessionId: string): string[] {
    const turn = this.sessions.get(sessionId)
    this.sessions.delete(sessionId)
    return turn ? [...turn.paths] : []
  }

  private turnOf(sessionId: string): TurnWrites {
    let turn = this.sessions.get(sessionId)
    if (!turn) {
      turn = { toolIds: new Set(), indexes: new Set(), paths: new Set() }
      this.sessions.set(sessionId, turn)
    }
    return turn
  }

  private read(turn: TurnWrites, toolInput: string): void {
    if (turn.paths.size >= OBSERVED_PATHS_MAX) return
    let input: z.infer<typeof writeInputSchema>
    try {
      const parsed = writeInputSchema.safeParse(JSON.parse(toolInput))
      if (!parsed.success) return
      input = parsed.data
    } catch {
      return
    }
    for (const path of [input.file_path, input.notebook_path, ...(input.changes ?? []).map((change) => change.path)]) {
      // A relative path is in the working directory, which is not a session folder.
      if (path && isAbsolute(path) && turn.paths.size < OBSERVED_PATHS_MAX) turn.paths.add(path)
    }
  }
}

import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { getDb } from '../../db'

/**
 * WORKAROUND(openai/codex#54472): the seat whose Codex app-server last ran
 * each Codex thread.
 *
 * Every Codex home keeps its own projection of a thread's history
 * (`thread_history_1.sqlite`), and an unloaded `thread/read` or
 * `thread/items/list` reads only that projection: it never projects the shared
 * rollout first. A thread a member's seat ran therefore reads empty or stale
 * through any other app-server. The seat that last ran a thread brought its
 * projection up to date, so `CodexBackend` reads history through that seat.
 *
 * Delete this file, and every `WORKAROUND(openai/codex#54472)` in
 * `codex-backend.ts` and `seat-manager.ts`, when a Codex release projects the
 * rollout on read. The rows are `kv` keys, so nothing needs a migration.
 */

const KEY_PREFIX = 'codex-thread-writer:'
const rowSchema = z.object({ value: z.string() })

export class CodexThreadWriters {
  constructor(private readonly database: () => DatabaseSync = getDb) {}

  /** The seat key that last ran the thread, or null for a thread run before this record existed. */
  get(threadId: string): string | null {
    return rowSchema.safeParse(this.database()
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(KEY_PREFIX + threadId)).data?.value ?? null
  }

  record(threadId: string, seatKey: string): void {
    this.database()
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(KEY_PREFIX + threadId, seatKey)
  }
}

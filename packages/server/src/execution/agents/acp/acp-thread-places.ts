import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { createLogger } from '../../../logger'

const log = createLogger('AcpThreadPlaces', 'acp-thread-places.ts')

const placesSchema = z.record(z.string(), z.record(z.string(), z.string())).catch({})

/**
 * Which agent session holds a Solus thread in each place it ran
 * (docs/plans/antigravity-provider.md §5.7). A Solus thread keeps the id of the
 * agent session that started it. agy keeps a session in one profile, so when
 * another member's seat, or another host, continues the thread, a new agent
 * session starts there with the handoff text, and this record maps the thread
 * to it. A place is an agent profile on this host.
 */
export class AcpThreadPlaces {
  private places: z.infer<typeof placesSchema>

  constructor(private readonly file: string) {
    this.places = AcpThreadPlaces.read(file)
  }

  private static read(file: string): z.infer<typeof placesSchema> {
    try {
      return placesSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      return {}
    }
  }

  /** The agent session that holds the thread in this place; undefined when none was recorded. */
  agentSession(threadId: string, place: string): string | undefined {
    return this.places[threadId]?.[place]
  }

  record(threadId: string, place: string, agentSessionId: string): void {
    if (this.places[threadId]?.[place] === agentSessionId) return
    this.places[threadId] = { ...this.places[threadId], [place]: agentSessionId }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.places), { mode: 0o600 })
    } catch (error) {
      log.warn('acp_thread_places_write_failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

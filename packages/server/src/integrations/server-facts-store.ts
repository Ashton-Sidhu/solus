import type { SQLInputValue } from 'node:sqlite'
import { isSpecType, type PriorDiscovery } from '@modelcontextprotocol/client'
import { sql, type SQL } from 'drizzle-orm'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'
import type { IntegrationFacts } from '@solus/contracts/integration-types'
import { getDb } from '../db'
import { createLogger } from '../logger'
import type { UpstreamTool } from './gateway'

const log = createLogger('integrations', 'server-facts-store.ts')

/** A list bigger than this is not saved: the next start lists again (docs/plans/mcp-first-class.md §7.5). */
const FACTS_MAX_BYTES = 1024 * 1024

/** What a run reads of a `stdio` integration when its process is not running. */
export interface SavedServerFacts {
  tools: UpstreamTool[]
  era: IntegrationFacts['era']
  instructions: string | null
  capabilities: IntegrationFacts['capabilities']
}

/** One person's and account's saved row. `verdict.checkedAt` is when a revision check made it. */
export interface SavedServerRow {
  verdict: { prior: PriorDiscovery; checkedAt: number } | null
  facts: SavedServerFacts | null
}

/** The owner of one saved row: the SDK guide forbids sharing a saved `DiscoverResult` between principals. */
export interface ServerFactsKey {
  integrationId: string
  personKey: string
  accountId: string
}

const rowSchema = z.object({ verdict: z.string().nullable(), verdict_at: z.number().nullable(), facts: z.string().nullable() })

const factsSchema = z.object({
  tools: z.array(z.unknown()),
  era: z.enum(['modern', 'legacy']).nullable(),
  instructions: z.string().nullable(),
  capabilities: z.object({ prompts: z.boolean(), resources: z.boolean(), resourceSubscribe: z.boolean(), tasks: z.boolean() }),
})

const dialect = new SQLiteSyncDialect()

function prepared(query: SQL) {
  const { sql: text, params } = dialect.sqlToQuery(query)
  // SAFETY: the templates below bind only strings, numbers, and null, which SQLite accepts.
  return { statement: getDb().prepare(text), params: params as SQLInputValue[] }
}

/** A verdict as the SDK takes it, or null for a row it would refuse. `connect({ prior })` checks a modern one again. */
function priorOf(text: string): PriorDiscovery | null {
  const value: unknown = JSON.parse(text)
  const parsed = z.object({ kind: z.literal('legacy') }).strict().or(z.object({ kind: z.literal('modern'), discover: z.unknown() }).strict()).safeParse(value)
  if (!parsed.success) return null
  if (parsed.data.kind === 'legacy') return { kind: 'legacy' }
  return isSpecType.DiscoverResult(parsed.data.discover) ? { kind: 'modern', discover: parsed.data.discover } : null
}

function factsOf(text: string): SavedServerFacts | null {
  const parsed = factsSchema.safeParse(JSON.parse(text))
  if (!parsed.success) return null
  const tools: UpstreamTool[] = []
  for (const tool of parsed.data.tools) {
    if (!isSpecType.Tool(tool)) return null
    tools.push(tool)
  }
  return { ...parsed.data, tools }
}

/**
 * The saved verdict and server facts of `stdio` integrations (§7.5), in the
 * host table `integration_server_facts`. The gateway passes the verdict to
 * `connect({ prior })`, so the command starts once, and a run reads the facts
 * when no process runs, so a run start starts nothing. A row that does not
 * parse reads as absent: the next start checks and lists again.
 */
export class ServerFactsStore {
  get(key: ServerFactsKey): SavedServerRow | null {
    const { statement, params } = prepared(sql`
      SELECT verdict, verdict_at, facts FROM integration_server_facts
      WHERE integration_id = ${key.integrationId} AND user_id = ${key.personKey} AND account_id = ${key.accountId}
    `)
    const found = statement.get(...params)
    if (!found) return null
    const row = rowSchema.parse(found)
    try {
      const prior = row.verdict ? priorOf(row.verdict) : null
      return {
        verdict: prior && row.verdict_at !== null ? { prior, checkedAt: row.verdict_at } : null,
        facts: row.facts ? factsOf(row.facts) : null,
      }
    } catch (error) {
      log.warn('integration_server_facts_unreadable', { integrationId: key.integrationId, error: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  saveVerdict(key: ServerFactsKey, prior: PriorDiscovery, checkedAt: number): void {
    const verdict = JSON.stringify(prior)
    this.upsert(key, sql`verdict = ${verdict}, verdict_at = ${checkedAt}`, sql`${verdict}, ${checkedAt}, NULL`, checkedAt)
  }

  /** False when the facts are over the size limit and were not saved. */
  saveFacts(key: ServerFactsKey, facts: SavedServerFacts, storedAt: number): boolean {
    const text = JSON.stringify(facts)
    if (Buffer.byteLength(text) > FACTS_MAX_BYTES) {
      log.warn('integration_server_facts_too_large', { integrationId: key.integrationId, bytes: Buffer.byteLength(text) })
      return false
    }
    this.upsert(key, sql`facts = ${text}`, sql`NULL, NULL, ${text}`, storedAt)
    return true
  }

  /** Test again, a failed revision, or a new command: the next start checks the revision again. */
  dropVerdicts(integrationId: string): void {
    this.run(sql`UPDATE integration_server_facts SET verdict = NULL, verdict_at = NULL WHERE integration_id = ${integrationId}`)
  }

  dropVerdict(key: ServerFactsKey): void {
    this.run(sql`
      UPDATE integration_server_facts SET verdict = NULL, verdict_at = NULL
      WHERE integration_id = ${key.integrationId} AND user_id = ${key.personKey} AND account_id = ${key.accountId}
    `)
  }

  /** A new command or names, or a removal: no row of the integration stays. */
  removeAllFor(integrationId: string): void {
    this.run(sql`DELETE FROM integration_server_facts WHERE integration_id = ${integrationId}`)
  }

  private upsert(key: ServerFactsKey, update: SQL, values: SQL, storedAt: number): void {
    this.run(sql`
      INSERT INTO integration_server_facts (integration_id, user_id, account_id, verdict, verdict_at, facts, stored_at)
      VALUES (${key.integrationId}, ${key.personKey}, ${key.accountId}, ${values}, ${storedAt})
      ON CONFLICT (integration_id, user_id, account_id) DO UPDATE SET ${update}, stored_at = ${storedAt}
    `)
  }

  private run(query: SQL): void {
    const { statement, params } = prepared(query)
    statement.run(...params)
  }
}

import type { SQLInputValue } from 'node:sqlite'
import { sql, type SQL } from 'drizzle-orm'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'
import { integrationAuthSchema, type Integration, type IntegrationAuth } from '@solus/contracts/integration-types'
import { ulid } from '@solus/contracts/ulid'
import type { RecordScope } from '../admission/principal'
import { scopeClause } from '../data/scope'
import { getDb, withTx } from '../db'

/**
 * The integrations this host knows (docs/plans/mcp-integrations.md §3.3). A host
 * table, read synchronously, whose reads name their scope through `scopeClause`
 * like every root record. The slug is unique per organization; a second add of
 * one name gets a numeric suffix.
 */

const SLUG_MAX_LENGTH = 40

const integrationRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  kind: z.literal('mcp'),
  slug: z.string(),
  name: z.string(),
  url: z.string(),
  auth: z.string(),
  created_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

type IntegrationRow = z.infer<typeof integrationRowSchema>

const INTEGRATION_COLUMNS = sql.raw('id, organization_id, kind, slug, name, url, auth, created_by, created_at, updated_at')

const dialect = new SQLiteSyncDialect()

/** `slug` is the wanted slug; the store adds a suffix when the organization already has it. */
export interface IntegrationCreateInput {
  name: string
  url: string
  slug: string
  auth: IntegrationAuth
}

export interface IntegrationPatch {
  name?: string
  url?: string
  auth?: IntegrationAuth
}

function integrationFromRow(row: IntegrationRow): Integration {
  return {
    id: row.id,
    organizationId: row.organization_id,
    kind: row.kind,
    slug: row.slug,
    name: row.name,
    url: row.url,
    auth: integrationAuthSchema.parse(JSON.parse(row.auth)),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Runs a `sql` template on the host connection, so a scope renders through `scopeClause`. */
function prepared(query: SQL) {
  const { sql: text, params } = dialect.sqlToQuery(query)
  // SAFETY: the templates below bind only strings and null, which SQLite accepts.
  return { statement: getDb().prepare(text), params: params as SQLInputValue[] }
}

function all(query: SQL): IntegrationRow[] {
  const { statement, params } = prepared(query)
  return integrationRowSchema.array().parse(statement.all(...params))
}

function one(query: SQL): IntegrationRow | null {
  return all(query)[0] ?? null
}

function run(query: SQL): number {
  const { statement, params } = prepared(query)
  return Number(statement.run(...params).changes)
}

/** `base`, else `base-2`, `base-3`, … within the slug length. */
function slugCandidate(base: string, attempt: number): string {
  if (attempt === 1) return base
  const suffix = `-${attempt}`
  return `${base.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`
}

export class IntegrationStore {
  list(scope: RecordScope): Integration[] {
    return all(sql`SELECT ${INTEGRATION_COLUMNS} FROM integration WHERE ${scopeClause(scope)} ORDER BY name, id`).map(integrationFromRow)
  }

  get(id: string, scope: RecordScope): Integration | null {
    const row = one(sql`SELECT ${INTEGRATION_COLUMNS} FROM integration WHERE ${scopeClause(scope)} AND id = ${id}`)
    return row ? integrationFromRow(row) : null
  }

  getBySlug(slug: string, scope: RecordScope): Integration | null {
    const row = one(sql`SELECT ${INTEGRATION_COLUMNS} FROM integration WHERE ${scopeClause(scope)} AND slug = ${slug} ORDER BY organization_id LIMIT 1`)
    return row ? integrationFromRow(row) : null
  }

  create(input: IntegrationCreateInput, organizationId: string, createdBy: string | null): Integration {
    const now = new Date().toISOString()
    const id = ulid()
    const auth = JSON.stringify(integrationAuthSchema.parse(input.auth))
    withTx(() => {
      for (let attempt = 1; ; attempt++) {
        const slug = slugCandidate(input.slug, attempt)
        const taken = one(sql`SELECT ${INTEGRATION_COLUMNS} FROM integration WHERE organization_id = ${organizationId} AND slug = ${slug}`)
        if (taken) continue
        run(sql`
          INSERT INTO integration (id, organization_id, kind, slug, name, url, auth, created_by, created_at, updated_at)
          VALUES (${id}, ${organizationId}, 'mcp', ${slug}, ${input.name}, ${input.url}, ${auth}, ${createdBy}, ${now}, ${now})
        `)
        return
      }
    })
    const created = this.get(id, organizationId)
    if (!created) throw new Error('The integration could not be saved.')
    return created
  }

  /** The record after the patch, or null when it is not in `scope`. The slug never changes: it names the tools. */
  update(id: string, patch: IntegrationPatch, scope: RecordScope): Integration | null {
    const existing = this.get(id, scope)
    if (!existing) return null
    const name = patch.name ?? existing.name
    const url = patch.url ?? existing.url
    const auth = JSON.stringify(integrationAuthSchema.parse(patch.auth ?? existing.auth))
    run(sql`
      UPDATE integration SET name = ${name}, url = ${url}, auth = ${auth}, updated_at = ${new Date().toISOString()}
      WHERE ${scopeClause(scope)} AND id = ${id}
    `)
    return this.get(id, scope)
  }

  remove(id: string, scope: RecordScope): boolean {
    return run(sql`DELETE FROM integration WHERE ${scopeClause(scope)} AND id = ${id}`) > 0
  }
}

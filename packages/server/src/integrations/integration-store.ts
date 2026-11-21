import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { integrationAuthSchema, integrationKindSchema, integrationLaunchSchema, solusServerIdOf, stdioServerAddressSchema, type Integration, type IntegrationAuth, type IntegrationKind, type IntegrationLaunch } from '@solus/contracts/integration-types'
import { ulid } from '@solus/contracts/ulid'
import type { RecordScope } from '../admission/principal'
import { scopeClause } from '../data/scope'
import { withTx } from '../db'
import { firstRow, rows, runSql } from '../db/sql'

/**
 * The integrations this host knows (docs/plans/mcp-integrations.md §3.3). A host
 * table, read synchronously, whose reads name their scope through `scopeClause`
 * like every root record. Every record is one person's
 * (docs/plans/access-model.md §2.3, D3): nobody else reads or changes it, so a
 * read names its owner. The slug is unique among one person's records in an
 * organization; a second add of one name gets a numeric suffix.
 */

const SLUG_MAX_LENGTH = 40

const integrationRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  created_by: z.string(),
  kind: integrationKindSchema,
  slug: z.string(),
  name: z.string(),
  url: z.string(),
  auth: z.string(),
  disabled_tools: z.string(),
  launch: z.string().nullable(),
  project_key: z.string().nullable(),
  project_name: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

type IntegrationRow = z.infer<typeof integrationRowSchema>

const INTEGRATION_COLUMNS = sql.raw('id, organization_id, created_by, kind, slug, name, url, auth, disabled_tools, launch, project_key, project_name, created_at, updated_at')

/**
 * `slug` is the wanted slug; the store adds a suffix when the owner already has
 * it. `launch` goes with a `stdio:` address (docs/plans/mcp-first-class.md §7.1),
 * `projectKey` and `projectName` with an integration that joins one project's runs (§8.4).
 */
export interface IntegrationCreateInput {
  name: string
  url: string
  slug: string
  auth: IntegrationAuth
  launch?: IntegrationLaunch
  projectKey?: string
  projectName?: string
}

/** A `stdio` integration's new `launch` comes with its new address. */
export interface IntegrationPatch {
  name?: string
  url?: string
  auth?: IntegrationAuth
  disabledTools?: string[]
  launch?: IntegrationLaunch
}

/** What an address names: a Solus MCP server, a command, or a server at a URL. */
function kindOf(url: string): IntegrationKind {
  if (solusServerIdOf(url)) return 'solus'
  return stdioServerAddressSchema.safeParse(url).success ? 'stdio' : 'mcp'
}

/** A command goes with a `stdio:` address and with no other. */
function launchColumn(url: string, launch: IntegrationLaunch | undefined): string | null {
  if ((kindOf(url) === 'stdio') !== (launch !== undefined)) throw new Error('A command goes with a stdio address, and a stdio address with a command.')
  return launch ? JSON.stringify(integrationLaunchSchema.parse(launch)) : null
}

function integrationFromRow(row: IntegrationRow): Integration {
  const integration: Integration = {
    id: row.id,
    organizationId: row.organization_id,
    ownerKey: row.created_by,
    kind: row.kind,
    slug: row.slug,
    name: row.name,
    url: row.url,
    auth: integrationAuthSchema.parse(JSON.parse(row.auth)),
    disabledTools: z.array(z.string()).parse(JSON.parse(row.disabled_tools)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.launch !== null) integration.launch = integrationLaunchSchema.parse(JSON.parse(row.launch))
  if (row.project_key !== null) integration.projectKey = row.project_key
  if (row.project_name !== null) integration.projectName = row.project_name
  return integration
}

/** One person's records. The host's own work and a runner (null) own none. */
function ownerClause(ownerKey: string | null): SQL {
  return ownerKey === null ? sql`1 = 0` : sql`created_by = ${ownerKey}`
}

/** `base`, else `base-2`, `base-3`, … within the slug length. */
function slugCandidate(base: string, attempt: number): string {
  if (attempt === 1) return base
  const suffix = `-${attempt}`
  return `${base.slice(0, SLUG_MAX_LENGTH - suffix.length).replace(/-+$/, '')}${suffix}`
}

export class IntegrationStore {
  /** One person's records in `scope`. */
  list(scope: RecordScope, ownerKey: string | null): Integration[] {
    return rows(sql`SELECT ${INTEGRATION_COLUMNS} FROM integration WHERE ${scopeClause(scope)} AND ${ownerClause(ownerKey)} ORDER BY name, id`, integrationRowSchema).map(integrationFromRow)
  }

  /** Every record in `scope`, whoever owns it: for host work that follows a fact of the host, such as a loopback port (mcp-first-class.md §9.3). */
  listAnyOwner(scope: RecordScope): Integration[] {
    return rows(sql`SELECT ${INTEGRATION_COLUMNS} FROM integration WHERE ${scopeClause(scope)} ORDER BY name, id`, integrationRowSchema).map(integrationFromRow)
  }

  /** Any record by id in `scope`, whoever owns it: for the gateway and the flows, which act on a record a person already reached. */
  get(id: string, scope: RecordScope): Integration | null {
    const row = firstRow(sql`SELECT ${INTEGRATION_COLUMNS} FROM integration WHERE ${scopeClause(scope)} AND id = ${id}`, integrationRowSchema)
    return row ? integrationFromRow(row) : null
  }

  /** A record by id, when it is this person's. */
  getOwned(id: string, scope: RecordScope, ownerKey: string | null): Integration | null {
    const row = firstRow(sql`SELECT ${INTEGRATION_COLUMNS} FROM integration WHERE ${scopeClause(scope)} AND ${ownerClause(ownerKey)} AND id = ${id}`, integrationRowSchema)
    return row ? integrationFromRow(row) : null
  }

  getBySlug(slug: string, scope: RecordScope, ownerKey: string | null): Integration | null {
    const row = firstRow(sql`SELECT ${INTEGRATION_COLUMNS} FROM integration WHERE ${scopeClause(scope)} AND ${ownerClause(ownerKey)} AND slug = ${slug} ORDER BY organization_id LIMIT 1`, integrationRowSchema)
    return row ? integrationFromRow(row) : null
  }

  /** The person's first record with this URL. */
  findByUrl(url: string, scope: RecordScope, ownerKey: string | null): Integration | null {
    const row = firstRow(sql`SELECT ${INTEGRATION_COLUMNS} FROM integration WHERE ${scopeClause(scope)} AND ${ownerClause(ownerKey)} AND url = ${url} ORDER BY created_at LIMIT 1`, integrationRowSchema)
    return row ? integrationFromRow(row) : null
  }

  /** A new record of `ownerKey`, who made it: `created_by`. */
  create(input: IntegrationCreateInput, organizationId: string, ownerKey: string): Integration {
    const now = new Date().toISOString()
    const id = ulid()
    const auth = JSON.stringify(integrationAuthSchema.parse(input.auth))
    // A `solus:` address names a Solus MCP server the host runs itself (§13.6); a `stdio:` address, a command.
    const kind = kindOf(input.url)
    const launch = launchColumn(input.url, input.launch)
    withTx(() => {
      for (let attempt = 1; ; attempt++) {
        const slug = slugCandidate(input.slug, attempt)
        const taken = firstRow(sql`SELECT ${INTEGRATION_COLUMNS} FROM integration WHERE organization_id = ${organizationId} AND ${ownerClause(ownerKey)} AND slug = ${slug}`, integrationRowSchema)
        if (taken) continue
        runSql(sql`
          INSERT INTO integration (id, organization_id, created_by, kind, slug, name, url, auth, launch, project_key, project_name, created_at, updated_at)
          VALUES (${id}, ${organizationId}, ${ownerKey}, ${kind}, ${slug}, ${input.name}, ${input.url}, ${auth}, ${launch}, ${input.projectKey ?? null}, ${input.projectName ?? null}, ${now}, ${now})
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
    const disabledTools = JSON.stringify([...new Set(patch.disabledTools ?? existing.disabledTools)].sort())
    // The kind never changes: a URL cannot become a command, nor a command a URL.
    if (kindOf(url) !== existing.kind) throw new Error('An integration keeps its kind: add a new one for another kind of server.')
    const launch = launchColumn(url, patch.launch ?? existing.launch)
    runSql(sql`
      UPDATE integration SET name = ${name}, url = ${url}, auth = ${auth}, disabled_tools = ${disabledTools}, launch = ${launch}, updated_at = ${new Date().toISOString()}
      WHERE ${scopeClause(scope)} AND id = ${id}
    `)
    return this.get(id, scope)
  }

  remove(id: string, scope: RecordScope): boolean {
    return runSql(sql`DELETE FROM integration WHERE ${scopeClause(scope)} AND id = ${id}`) > 0
  }
}

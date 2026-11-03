import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { PullRequest } from '@solus/contracts/providers'
import type { Db } from '../../db/database'
import { createLogger } from '../../logger'
import { captureActingScope, type ActingScope } from '../../vault/acting-scope'
import { pullRequestObservations, resourceLinks } from './schema'
import { pullRequestStateSchema, type PullRequestState } from './resource-links'

const log = createLogger('main', 'pull-request-observations')

/**
 * PR facts, once per organization and source authority (plans/029 §5.1). The
 * observation and every `keeps_session` bit that depends on it are written in
 * one transaction, so a read never sees a closed pull request still keeping its
 * session listed, or the reverse.
 */

/**
 * The authority of an observation: the visibility context the read had. The
 * host's own reads are one authority; each person's account is another. It
 * names a person by key, never by token.
 */
export function authorityKeyOf(scope: ActingScope | null): string {
  return scope?.personKey ? `person:${scope.personKey}` : 'host'
}

/** The bit an active session→pull-request edge stores: 1 while the pull request is open or not yet observed. */
export function keepsSession(state: PullRequestState | null): 0 | 1 {
  return state === null || state === 'open' ? 1 : 0
}

/**
 * The observation an edge reads, as `o`, for a read that selects
 * `resource_links`. A null `authority_key` on the edge joins nothing: PR sync
 * has not answered for it yet.
 */
export const OBSERVATION_JOIN: SQL = sql`LEFT JOIN ${pullRequestObservations} AS o
  ON o.organization_id = resource_links.organization_id AND o.authority_key = resource_links.authority_key
  AND o.repository = resource_links.repository AND o.number = resource_links.number`

/** The observation's columns as a reader's row schema parses them, after `OBSERVATION_JOIN`; spread them into the row object. */
export const OBSERVATION_ROW_COLUMNS = {
  pr_state: pullRequestStateSchema.nullable(),
  pr_draft: z.number().nullable(),
  pr_title: z.string().nullable(),
  pr_updated_at: z.string().nullable(),
}
export const observationColumnsSchema = z.object(OBSERVATION_ROW_COLUMNS)
export type ObservationColumns = z.infer<typeof observationColumnsSchema>

/** The observation's columns as the readers name them, after `OBSERVATION_JOIN`. */
export const OBSERVATION_COLUMNS: SQL = sql`o.state AS pr_state, o.draft AS pr_draft, o.title AS pr_title, o.updated_at AS pr_updated_at`

const latestRowSchema = z.object({ authority_key: z.string(), state: pullRequestStateSchema })

/**
 * The observation a new edge of this pull request binds to: the one most
 * recently written in the organization, whatever its authority. Null when
 * nothing has observed the pull request yet.
 */
export async function latestObservation(db: Db, organizationId: string, repository: string, number: number): Promise<{ authorityKey: string; state: PullRequestState } | null> {
  const row = latestRowSchema.nullish().parse(await db.get(sql`
    SELECT authority_key, state FROM ${pullRequestObservations}
    WHERE organization_id = ${organizationId} AND repository = ${repository} AND number = ${number}
    ORDER BY observed_at DESC LIMIT 1
  `))
  return row ? { authorityKey: row.authority_key, state: row.state } : null
}

export interface ObservationWrite {
  /** `host/owner/repo`, lower case. */
  repository: string
  number: number
  /** Every raw scope that names the repository: its key, and the checkout paths that resolved to it. */
  scopes: readonly string[]
  /** Null: the code host says that the pull request does not exist. */
  pullRequest: PullRequest | null
  /** Defaults to the authority of the current acting scope. */
  authorityKey?: string
  now?: number
}

const edgeRowSchema = z.object({
  organization_id: z.string(),
  source_kind: z.string(),
  source_id: z.string(),
  target_scope: z.string(),
  repository: z.string().nullable(),
  title: z.string(),
  pinned: z.number(),
})

const aliasRowSchema = z.object({ title: z.string(), pinned: z.number() })

/**
 * Write what PR sync saw for one pull request, and bind every edge that names
 * it to that observation, in one transaction. Answers the sessions and tasks
 * whose edges changed, for the callers to announce.
 *
 * An edge whose raw scope is a checkout path gets its canonical identity here.
 * Two raw aliases of one source that resolve to one pull request are never
 * silently merged: when the second alias disagrees with the first on its title
 * or its pin, it stays unresolved and is logged (`resource_link_alias_conflict`).
 */
export async function recordObservation(db: Db, write: ObservationWrite): Promise<{ sessionIds: string[]; taskIds: string[] }> {
  const repository = write.repository.toLowerCase()
  const authority = write.authorityKey ?? authorityKeyOf(captureActingScope())
  const key = String(write.number)
  const scopes = [...new Set([repository, ...write.scopes.map((scope) => scope.toLowerCase())])]
  return db.transaction(async (tx) => {
    const named = sql`resource_links.target_kind = 'pr' AND resource_links.target_key = ${key}
      AND (resource_links.target_scope IN (${sql.join(scopes.map((scope) => sql`${scope}`), sql`, `)})
        OR (resource_links.repository = ${repository} AND resource_links.number = ${write.number}))`
    const edges = edgeRowSchema.array().parse(await tx.all(sql`
      SELECT organization_id, source_kind, source_id, target_scope, repository, title, pinned FROM ${resourceLinks} WHERE ${named}
    `))
    if (!edges.length) return { sessionIds: [], taskIds: [] }

    const pullRequest = write.pullRequest
    const state: PullRequestState = pullRequest ? pullRequest.state : 'missing'
    const now = write.now ?? Date.now()
    for (const organizationId of new Set(edges.map((edge) => edge.organization_id))) {
      await tx.run(sql`
        INSERT INTO ${pullRequestObservations}(organization_id, authority_key, repository, number, state, draft, title, updated_at, observed_at)
        VALUES (${organizationId}, ${authority}, ${repository}, ${write.number}, ${state},
          ${pullRequest ? (pullRequest.draft ? 1 : 0) : null}, ${pullRequest?.title ?? ''}, ${pullRequest?.updatedAt ?? null}, ${now})
        ON CONFLICT(organization_id, authority_key, repository, number) DO UPDATE SET
          state = excluded.state, draft = excluded.draft, updated_at = excluded.updated_at, observed_at = excluded.observed_at,
          title = CASE WHEN excluded.state = 'missing' THEN pull_request_observations.title ELSE excluded.title END
      `)
    }

    // Resolution: a raw alias takes the canonical identity, unless another alias of its source holds it already and disagrees.
    for (const edge of edges) {
      if (edge.repository !== null) continue
      const held = aliasRowSchema.nullish().parse(await tx.get(sql`
        SELECT title, pinned FROM ${resourceLinks}
        WHERE resource_links.source_kind = ${edge.source_kind} AND resource_links.source_id = ${edge.source_id}
          AND resource_links.target_kind = 'pr' AND resource_links.repository = ${repository} AND resource_links.number = ${write.number}
          AND resource_links.target_scope <> ${edge.target_scope}
        LIMIT 1
      `))
      if (held && (held.title !== edge.title || held.pinned !== edge.pinned)) {
        log.warn('resource_link_alias_conflict', { sourceKind: edge.source_kind, sourceId: edge.source_id, targetScope: edge.target_scope, repository, number: write.number })
        continue
      }
      await tx.run(sql`
        UPDATE ${resourceLinks} SET repository = ${repository}, number = ${write.number}
        WHERE resource_links.source_kind = ${edge.source_kind} AND resource_links.source_id = ${edge.source_id}
          AND resource_links.target_kind = 'pr' AND resource_links.target_scope = ${edge.target_scope} AND resource_links.target_key = ${key}
      `)
    }

    // The bit and the authority, on every edge that now names the observation. A
    // title-only change writes no edge.
    const bit = keepsSession(state)
    await tx.run(sql`
      UPDATE ${resourceLinks} SET authority_key = ${authority},
        keeps_session = CASE WHEN resource_links.source_kind = 'session' AND resource_links.relation = 'pull-request' AND resource_links.status = 'active' THEN ${bit} ELSE 0 END
      WHERE resource_links.target_kind = 'pr' AND resource_links.repository = ${repository} AND resource_links.number = ${write.number}
        AND (COALESCE(resource_links.authority_key, '') <> ${authority}
          OR resource_links.keeps_session <> CASE WHEN resource_links.source_kind = 'session' AND resource_links.relation = 'pull-request' AND resource_links.status = 'active' THEN ${bit} ELSE 0 END)
    `)
    return {
      sessionIds: [...new Set(edges.filter((edge) => edge.source_kind === 'session').map((edge) => edge.source_id))],
      taskIds: [...new Set(edges.filter((edge) => edge.source_kind === 'task').map((edge) => edge.source_id))],
    }
  })
}

const stateRowSchema = z.object({ state: pullRequestStateSchema })

/** Whether any observation of this pull request, under any authority, says that it is merged. */
export async function pullRequestObservedMerged(db: Db, repository: string, number: number): Promise<boolean> {
  const rows = stateRowSchema.array().parse(await db.all(sql`
    SELECT state FROM ${pullRequestObservations} WHERE repository = ${repository.toLowerCase()} AND number = ${number}
  `))
  return rows.some((row) => row.state === 'merged')
}

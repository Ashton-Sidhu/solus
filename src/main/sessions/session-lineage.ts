import type { DatabaseSync } from 'node:sqlite'
import type { AgentId, SessionLineageMember, SessionLineageResolution } from '../../shared/types'
import { getDb } from '../db'
import { z } from 'zod'

interface SessionLineageMemberRow {
  session_id: string
  position: number
  provider: AgentId
  provider_session_id: string | null
  cwd: string
  started_at: number
  ended_at: number | null
  updated_at: number
}

const sessionLineageMemberRowSchema = z.object({
  session_id: z.string(),
  position: z.number(),
  provider: z.enum(['claude-code', 'codex', 'opencode']),
  provider_session_id: z.string().nullable(),
  cwd: z.string(),
  started_at: z.number(),
  ended_at: z.number().nullable(),
  updated_at: z.number(),
})

const lineageIdRowSchema = z.object({ session_id: z.string() })

export interface BeginSessionHandoffInput {
  sessionId: string
  sourceProvider: AgentId
  sourceProviderSessionId: string
  targetProvider: AgentId
  cwd: string
  now?: number
}

function memberFromRow(row: SessionLineageMemberRow): SessionLineageMember {
  return {
    position: row.position,
    provider: row.provider,
    providerSessionId: row.provider_session_id,
    cwd: row.cwd,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  }
}

function resolutionFromRows(rows: SessionLineageMemberRow[]): SessionLineageResolution | null {
  if (rows.length === 0) return null
  const members = rows.map(memberFromRow)
  return {
    sessionId: rows[0].session_id,
    members,
    active: members[members.length - 1],
    lineageToken: rows
      .map((row) => `${row.position}:${row.provider}:${row.provider_session_id ?? ''}:${row.updated_at}`)
      .join('|'),
  }
}

function rowsForLineage(db: DatabaseSync, sessionId: string): SessionLineageMemberRow[] {
  return z.array(sessionLineageMemberRowSchema).parse(db.prepare(`
    SELECT session_id, position, provider, provider_session_id, cwd, started_at, ended_at, updated_at
    FROM session_lineage_members
    WHERE session_id = ?
    ORDER BY position
  `).all(sessionId))
}

export function resolveSessionLineage(
  provider: AgentId,
  providerSessionId: string,
  db: DatabaseSync = getDb(),
): SessionLineageResolution | null {
  const parsed = lineageIdRowSchema.safeParse(db.prepare(`
    SELECT session_id
    FROM session_lineage_members
    WHERE provider = ? AND provider_session_id = ?
  `).get(provider, providerSessionId))
  return parsed.success ? resolutionFromRows(rowsForLineage(db, parsed.data.session_id)) : null
}

/** The stable session id behind a provider thread, when the provider is not known.
 *  Provider thread ids are provider-issued uuids, so matching on the id alone is
 *  unambiguous in practice and saves callers guessing which backend owns it. */
export function stableSessionIdForProviderThread(
  providerSessionId: string,
  db: DatabaseSync = getDb(),
): string | undefined {
  const parsed = lineageIdRowSchema.safeParse(db.prepare(`
    SELECT session_id
    FROM session_lineage_members
    WHERE provider_session_id = ?
  `).get(providerSessionId))
  return parsed.success ? parsed.data.session_id : undefined
}

export function resolveSessionLineageById(
  sessionId: string,
  db: DatabaseSync = getDb(),
): SessionLineageResolution | null {
  return resolutionFromRows(rowsForLineage(db, sessionId))
}

/**
 * Bind a provider thread to a stable session id, durably and once.
 *
 * First writer wins. If the thread is already registered — because another client
 * named it first, or because this server registered it before a restart — the
 * registered id is returned and the proposed one is discarded. Callers must route
 * by the returned id, never by the one they passed in. This is what stops two
 * clients holding two names for one conversation.
 *
 * Registering an already-registered thread under its own id is a no-op, so this is
 * safe to call on every session_init.
 */
export function registerSessionLineage(
  input: { sessionId: string; provider: AgentId; providerSessionId: string; cwd: string; now?: number },
  db: DatabaseSync = getDb(),
): SessionLineageResolution {
  const now = input.now ?? Date.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = resolveSessionLineage(input.provider, input.providerSessionId, db)
    if (existing) {
      db.exec('COMMIT')
      return existing
    }
    // The session may already have a lineage this thread is not in yet — a handoff
    // whose provisional target just started. completeSessionHandoff owns that row;
    // do not append a competing one.
    const rows = rowsForLineage(db, input.sessionId)
    if (rows.length > 0) {
      const resolution = resolutionFromRows(rows)
      if (!resolution) throw new Error(`Session ${input.sessionId} lineage vanished mid-transaction`)
      db.exec('COMMIT')
      return resolution
    }
    db.prepare(`
      INSERT INTO session_lineage_members(
        session_id, position, provider, provider_session_id, cwd, started_at, ended_at, updated_at
      ) VALUES (?, 0, ?, ?, ?, ?, NULL, ?)
    `).run(input.sessionId, input.provider, input.providerSessionId, input.cwd, now, now)
    const resolution = resolutionFromRows(rowsForLineage(db, input.sessionId))
    if (!resolution) throw new Error(`Failed to register session ${input.sessionId}`)
    db.exec('COMMIT')
    return resolution
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function beginSessionHandoff(
  input: BeginSessionHandoffInput,
  db: DatabaseSync = getDb(),
): SessionLineageResolution {
  const now = input.now ?? Date.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    let rows = rowsForLineage(db, input.sessionId)
    if (rows.length === 0) {
      db.prepare(`
        INSERT INTO session_lineage_members(
          session_id, position, provider, provider_session_id, cwd, started_at, ended_at, updated_at
        ) VALUES (?, 0, ?, ?, ?, ?, ?, ?)
      `).run(
        input.sessionId,
        input.sourceProvider,
        input.sourceProviderSessionId,
        input.cwd,
        now,
        now,
        now,
      )
      rows = rowsForLineage(db, input.sessionId)
    }

    const active = rows[rows.length - 1]
    if (active.provider_session_id === null) {
      throw new Error(`Handoff ${input.sessionId} already has a provisional target`)
    }
    if (active.provider !== input.sourceProvider || active.provider_session_id !== input.sourceProviderSessionId) {
      throw new Error(`Handoff ${input.sessionId} source is not its active provider session`)
    }

    db.prepare(`
      UPDATE session_lineage_members
      SET ended_at = ?, updated_at = ?
      WHERE session_id = ? AND position = ?
    `).run(now, now, input.sessionId, active.position)
    db.prepare(`
      INSERT INTO session_lineage_members(
        session_id, position, provider, provider_session_id, cwd, started_at, ended_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?)
    `).run(input.sessionId, active.position + 1, input.targetProvider, input.cwd, now, now)

    const resolution = resolutionFromRows(rowsForLineage(db, input.sessionId))
    if (!resolution) throw new Error(`Failed to create handoff ${input.sessionId}`)
    db.exec('COMMIT')
    return resolution
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function completeSessionHandoff(
  sessionId: string,
  provider: AgentId,
  providerSessionId: string,
  cwd: string,
  db: DatabaseSync = getDb(),
  now = Date.now(),
): SessionLineageResolution {
  db.exec('BEGIN IMMEDIATE')
  try {
    const rows = rowsForLineage(db, sessionId)
    const active = rows.at(-1)
    if (!active) throw new Error(`Session ${sessionId} has no lineage`)
    if (active.provider !== provider) throw new Error(`Session ${sessionId} is not targeting ${provider}`)
    if (active.provider_session_id && active.provider_session_id !== providerSessionId) {
      throw new Error(`Session ${sessionId} already targets another provider session`)
    }
    db.prepare(`
      UPDATE session_lineage_members
      SET provider_session_id = ?, cwd = ?, updated_at = ?
      WHERE session_id = ? AND position = ?
    `).run(providerSessionId, cwd, now, sessionId, active.position)
    const resolution = resolutionFromRows(rowsForLineage(db, sessionId))
    if (!resolution) throw new Error(`Failed to complete handoff ${sessionId}`)
    db.exec('COMMIT')
    return resolution
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function cancelProvisionalSessionHandoff(
  sessionId: string,
  db: DatabaseSync = getDb(),
  now = Date.now(),
): SessionLineageResolution | null {
  db.exec('BEGIN IMMEDIATE')
  try {
    const rows = rowsForLineage(db, sessionId)
    const provisional = rows.at(-1)
    if (!provisional || provisional.provider_session_id !== null) {
      throw new Error(`Session ${sessionId} has no provisional target`)
    }
    db.prepare('DELETE FROM session_lineage_members WHERE session_id = ? AND position = ?')
      .run(sessionId, provisional.position)
    const previous = rows.at(-2)
    if (rows.length === 2) {
      db.prepare('DELETE FROM session_lineage_members WHERE session_id = ?').run(sessionId)
    } else if (previous) {
      db.prepare(`
        UPDATE session_lineage_members
        SET ended_at = NULL, updated_at = ?
        WHERE session_id = ? AND position = ?
      `).run(now, sessionId, previous.position)
    }
    const resolution = resolutionFromRows(rowsForLineage(db, sessionId))
    db.exec('COMMIT')
    return resolution
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

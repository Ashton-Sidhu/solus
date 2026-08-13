import type { DatabaseSync } from 'node:sqlite'
import type { AgentId, SessionHandoffMember, SessionHandoffResolution } from '../../shared/types'
import { getDb } from '../db'
import { z } from 'zod'

interface SessionHandoffMemberRow {
  handoff_id: string
  position: number
  provider: string
  provider_session_id: string | null
  cwd: string
  started_at: number
  ended_at: number | null
  updated_at: number
}

const sessionHandoffMemberRowSchema = z.object({
  handoff_id: z.string(),
  position: z.number(),
  provider: z.enum(['claude-code', 'codex', 'opencode']),
  provider_session_id: z.string().nullable(),
  cwd: z.string(),
  started_at: z.number(),
  ended_at: z.number().nullable(),
  updated_at: z.number(),
})

const handoffIdRowSchema = z.object({ handoff_id: z.string() })

export interface BeginSessionHandoffInput {
  handoffId: string
  sourceProvider: AgentId
  sourceProviderSessionId: string
  targetProvider: AgentId
  cwd: string
  now?: number
}

function memberFromRow(row: SessionHandoffMemberRow): SessionHandoffMember {
  return {
    position: row.position,
    provider: row.provider,
    providerSessionId: row.provider_session_id,
    cwd: row.cwd,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  }
}

function resolutionFromRows(rows: SessionHandoffMemberRow[]): SessionHandoffResolution | null {
  if (rows.length === 0) return null
  const members = rows.map(memberFromRow)
  return {
    handoffId: rows[0].handoff_id,
    members,
    active: members[members.length - 1],
    lineageToken: rows
      .map((row) => `${row.position}:${row.provider}:${row.provider_session_id ?? ''}:${row.updated_at}`)
      .join('|'),
  }
}

function rowsForHandoff(db: DatabaseSync, handoffId: string): SessionHandoffMemberRow[] {
  return z.array(sessionHandoffMemberRowSchema).parse(db.prepare(`
    SELECT handoff_id, position, provider, provider_session_id, cwd, started_at, ended_at, updated_at
    FROM session_handoff_members
    WHERE handoff_id = ?
    ORDER BY position
  `).all(handoffId))
}

export function resolveSessionHandoff(
  provider: AgentId,
  providerSessionId: string,
  db: DatabaseSync = getDb(),
): SessionHandoffResolution | null {
  const parsed = handoffIdRowSchema.safeParse(db.prepare(`
    SELECT handoff_id
    FROM session_handoff_members
    WHERE provider = ? AND provider_session_id = ?
  `).get(provider, providerSessionId))
  return parsed.success ? resolutionFromRows(rowsForHandoff(db, parsed.data.handoff_id)) : null
}

export function resolveSessionHandoffById(
  handoffId: string,
  db: DatabaseSync = getDb(),
): SessionHandoffResolution | null {
  return resolutionFromRows(rowsForHandoff(db, handoffId))
}

export function beginSessionHandoff(
  input: BeginSessionHandoffInput,
  db: DatabaseSync = getDb(),
): SessionHandoffResolution {
  const now = input.now ?? Date.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    let rows = rowsForHandoff(db, input.handoffId)
    if (rows.length === 0) {
      db.prepare(`
        INSERT INTO session_handoff_members(
          handoff_id, position, provider, provider_session_id, cwd, started_at, ended_at, updated_at
        ) VALUES (?, 0, ?, ?, ?, ?, ?, ?)
      `).run(
        input.handoffId,
        input.sourceProvider,
        input.sourceProviderSessionId,
        input.cwd,
        now,
        now,
        now,
      )
      rows = rowsForHandoff(db, input.handoffId)
    }

    const active = rows[rows.length - 1]
    if (active.provider_session_id === null) {
      throw new Error(`Handoff ${input.handoffId} already has a provisional target`)
    }
    if (active.provider !== input.sourceProvider || active.provider_session_id !== input.sourceProviderSessionId) {
      throw new Error(`Handoff ${input.handoffId} source is not its active provider session`)
    }

    db.prepare(`
      UPDATE session_handoff_members
      SET ended_at = ?, updated_at = ?
      WHERE handoff_id = ? AND position = ?
    `).run(now, now, input.handoffId, active.position)
    db.prepare(`
      INSERT INTO session_handoff_members(
        handoff_id, position, provider, provider_session_id, cwd, started_at, ended_at, updated_at
      ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?)
    `).run(input.handoffId, active.position + 1, input.targetProvider, input.cwd, now, now)

    const resolution = resolutionFromRows(rowsForHandoff(db, input.handoffId))
    if (!resolution) throw new Error(`Failed to create handoff ${input.handoffId}`)
    db.exec('COMMIT')
    return resolution
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function completeSessionHandoff(
  handoffId: string,
  provider: AgentId,
  providerSessionId: string,
  cwd: string,
  db: DatabaseSync = getDb(),
  now = Date.now(),
): SessionHandoffResolution {
  db.exec('BEGIN IMMEDIATE')
  try {
    const rows = rowsForHandoff(db, handoffId)
    const active = rows.at(-1)
    if (!active) throw new Error(`Handoff ${handoffId} does not exist`)
    if (active.provider !== provider) throw new Error(`Handoff ${handoffId} is not targeting ${provider}`)
    if (active.provider_session_id && active.provider_session_id !== providerSessionId) {
      throw new Error(`Handoff ${handoffId} already targets another provider session`)
    }
    db.prepare(`
      UPDATE session_handoff_members
      SET provider_session_id = ?, cwd = ?, updated_at = ?
      WHERE handoff_id = ? AND position = ?
    `).run(providerSessionId, cwd, now, handoffId, active.position)
    const resolution = resolutionFromRows(rowsForHandoff(db, handoffId))
    if (!resolution) throw new Error(`Failed to complete handoff ${handoffId}`)
    db.exec('COMMIT')
    return resolution
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function cancelProvisionalSessionHandoff(
  handoffId: string,
  db: DatabaseSync = getDb(),
  now = Date.now(),
): SessionHandoffResolution | null {
  db.exec('BEGIN IMMEDIATE')
  try {
    const rows = rowsForHandoff(db, handoffId)
    const provisional = rows.at(-1)
    if (!provisional || provisional.provider_session_id !== null) {
      throw new Error(`Handoff ${handoffId} has no provisional target`)
    }
    db.prepare('DELETE FROM session_handoff_members WHERE handoff_id = ? AND position = ?')
      .run(handoffId, provisional.position)
    const previous = rows.at(-2)
    if (rows.length === 2) {
      db.prepare('DELETE FROM session_handoff_members WHERE handoff_id = ?').run(handoffId)
    } else if (previous) {
      db.prepare(`
        UPDATE session_handoff_members
        SET ended_at = NULL, updated_at = ?
        WHERE handoff_id = ? AND position = ?
      `).run(now, handoffId, previous.position)
    }
    const resolution = resolutionFromRows(rowsForHandoff(db, handoffId))
    db.exec('COMMIT')
    return resolution
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

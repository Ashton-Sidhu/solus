import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { rankSessions } from '@solus/contracts/session-search'
import type { Db } from './database'
import type { SessionMatchPage, SessionMatchQuery } from './search-index'

const candidateSchema = z.object({ session_id: z.string(), custom_title: z.string().nullable(), branch: z.string().nullable(), last_activity_at: z.coerce.number() })
const countSchema = z.object({ session_id: z.string(), count: z.coerce.number() })
const passageSchema = z.object({ session_id: z.string(), source_session_id: z.string(), position: z.coerce.number(), timestamp: z.coerce.number().nullable(), content: z.string(), message_id: z.string().nullable(), role: z.string() })

/** Both database engines retrieve normalized words. The shared scorer owns order. */
export async function searchMirroredSessions(db: Db, request: SessionMatchQuery): Promise<SessionMatchPage> {
  const { query } = request
  if (query.isEmpty) return { sessions: [], total: 0 }
  const candidates = candidateSchema.array().parse(await db.all(sql`
    SELECT session_id, custom_title, branch, last_activity_at FROM session WHERE ${request.records}
  `))
  if (!candidates.length) return { sessions: [], total: 0 }
  const field = (name: string): SQL => db.engine === 'postgres' ? sql`t.message::jsonb->>${name}` : sql`json_extract(t.message, ${'$.' + name})`
  const written = sql`${field('role')} IN ('user', 'assistant') AND ${field('toolName')} IS NULL AND ${field('parentToolUseId')} IS NULL`
  const inWord = (word: string): SQL => db.engine === 'postgres'
    ? sql`t.search @@ to_tsquery('simple', ${word + (/^\d+$/.test(word) ? '' : ':*')})`
    : sql`t.rowid IN (SELECT rowid FROM session_transcripts_fts WHERE session_transcripts_fts MATCH ${`"${word}"${/^\d+$/.test(word) ? '' : '*'}`})`
  const visible = sql`t.session_id = session.session_id AND t.organization_id = session.organization_id`
  // An optional filler word is in nearly every message and decides nothing;
  // only the phrase still holds it.
  const { required, words } = query
  const all = sql.join(required.map(inWord), sql` AND `)
  const phrase = sql`(' ' || t.search_text || ' ') LIKE ${`% ${words.join(' ')}${/^\d+$/.test(words.at(-1)!) ? ' ' : ''}%`}`
  const readCounts = async (match: SQL) => new Map(countSchema.array().parse(await db.all(sql`
    SELECT t.session_id, COUNT(*) AS count FROM session_transcripts t
    JOIN session ON ${visible}
    WHERE ${request.records} AND ${written} AND ${match} GROUP BY t.session_id
  `)).map(row => [row.session_id, row.count]))
  const perWord = request.namesOnly ? [] : await Promise.all(required.map(word => readCounts(inWord(word))))
  const together = !request.namesOnly && required.length > 1 ? await readCounts(all) : new Map<string, number>()
  const phrased = !request.namesOnly && words.length > 1 ? await readCounts(sql`${all} AND ${phrase}`) : new Map<string, number>()
  const matches = rankSessions(query, candidates.map(row => ({
    sessionId: row.session_id, title: row.custom_title, branch: row.branch, pullRequest: request.metadata?.get(row.session_id), lastActivity: row.last_activity_at,
  })), request.namesOnly ? null : {
    counts: candidate => perWord.map(counts => counts.get(candidate.sessionId) ?? 0),
    together: candidate => together.has(candidate.sessionId),
    phrase: candidate => phrased.has(candidate.sessionId),
  }, Date.now()).map(({ candidate, score, name }) => ({ sessionId: candidate.sessionId, score, name }))
  const page = matches.slice(request.offset, request.offset + request.limit)
  if (!page.length) return { sessions: [], total: matches.length }
  const passages = request.namesOnly ? [] : passageSchema.array().parse(await db.all(sql`
    SELECT best.session_id, best.source_session_id, best.position, best.timestamp, best.content, best.message_id, best.role FROM (
      SELECT t.session_id, t.position, CAST(${field('timestamp')} AS BIGINT) AS timestamp,
        COALESCE(${field('content')}, '') AS content, ${field('messageId')} AS message_id, ${field('role')} AS role,
        COALESCE(${field('sourceSessionId')}, t.session_id) AS source_session_id,
        ROW_NUMBER() OVER (PARTITION BY t.session_id ORDER BY CASE WHEN ${phrase} THEN 2 WHEN ${all} THEN 1 ELSE 0 END DESC, t.position DESC) AS n
      FROM session_transcripts t JOIN session ON ${visible}
      WHERE ${request.records} AND ${written}
        AND t.session_id IN (${sql.join(page.map(row => sql`${row.sessionId}`), sql`, `)})
        AND (${sql.join(required.map(inWord), sql` OR `)})
    ) best WHERE best.n <= 3 ORDER BY best.session_id, best.n
  `))
  return {
    total: matches.length,
    sessions: page.map(row => ({ sessionId: row.sessionId, rank: -row.score, reason: row.name?.reason ?? { field: 'messages', text: '' },
      passages: passages.filter(passage => passage.session_id === row.sessionId).map(passage => ({
        position: passage.position, timestamp: passage.timestamp, content: passage.content,
        target: { sourceSessionId: passage.source_session_id, messageId: passage.message_id, role: passage.role, timestamp: passage.timestamp ?? 0, text: passage.content.slice(0, 256) },
      })),
    })),
  }
}

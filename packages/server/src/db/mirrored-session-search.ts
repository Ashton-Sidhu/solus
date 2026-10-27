import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { searchTokens, searchTokenMatches, sessionNameScore, sessionEvidenceScore, type SessionNameScore } from '@solus/contracts/session-search'
import type { Db } from './database'
import type { SessionMatchPage, SessionMatchQuery } from './search-index'

const candidateSchema = z.object({ session_id: z.string(), custom_title: z.string().nullable(), branch: z.string().nullable(), last_activity_at: z.coerce.number() })
const countSchema = z.object({ session_id: z.string(), count: z.coerce.number() })
const passageSchema = z.object({ session_id: z.string(), source_session_id: z.string(), position: z.coerce.number(), timestamp: z.coerce.number().nullable(), content: z.string(), message_id: z.string().nullable(), role: z.string() })

/** Both database engines retrieve normalized words. The shared scorer owns order. */
export async function searchMirroredSessions(db: Db, request: SessionMatchQuery): Promise<SessionMatchPage> {
  const { words } = request
  if (!words.length) return { sessions: [], total: 0 }
  const candidates = candidateSchema.array().parse(await db.all(sql`
    SELECT session_id, custom_title, branch, last_activity_at FROM session_records WHERE ${request.records}
  `))
  if (!candidates.length) return { sessions: [], total: 0 }
  const field = (name: string): SQL => db.engine === 'postgres' ? sql`t.message::jsonb->>${name}` : sql`json_extract(t.message, ${'$.' + name})`
  const written = sql`${field('role')} IN ('user', 'assistant') AND ${field('toolName')} IS NULL AND ${field('parentToolUseId')} IS NULL`
  const inWord = (word: string): SQL => db.engine === 'postgres'
    ? sql`t.search @@ to_tsquery('simple', ${word + (/^\d+$/.test(word) ? '' : ':*')})`
    : sql`t.rowid IN (SELECT rowid FROM session_transcripts_fts WHERE session_transcripts_fts MATCH ${`"${word}"${/^\d+$/.test(word) ? '' : '*'}`})`
  const visible = sql`t.session_id = session_records.session_id AND t.organization_id = session_records.organization_id`
  const all = sql.join(words.map(inWord), sql` AND `)
  const phrase = sql`(' ' || t.search_text || ' ') LIKE ${`% ${words.join(' ')}${/^\d+$/.test(words.at(-1)!) ? ' ' : ''}%`}`
  const readCounts = async (match: SQL) => new Map(countSchema.array().parse(await db.all(sql`
    SELECT t.session_id, COUNT(*) AS count FROM session_transcripts t
    JOIN session_records ON ${visible}
    WHERE ${request.records} AND ${written} AND ${match} GROUP BY t.session_id
  `)).map(row => [row.session_id, row.count]))
  const perWord = request.namesOnly ? [] : await Promise.all(words.map(word => readCounts(inWord(word))))
  const several = !request.namesOnly && words.length > 1
  const together = several ? await readCounts(all) : new Map<string, number>()
  const phrased = several ? await readCounts(sql`${all} AND ${phrase}`) : new Map<string, number>()
  type Candidate = { sessionId: string; score: number; timestamp: number; name: SessionNameScore | null }
  const matches: Candidate[] = []
  for (const row of candidates) {
    const metadata = request.metadata?.get(row.session_id)
    const name = sessionNameScore({ id: row.session_id, title: row.custom_title, branch: row.branch, pullRequest: metadata }, words)
    const counts = words.map((_, index) => perWord[index]?.get(row.session_id) ?? 0)
    const nameTokens = searchTokens([row.custom_title, row.branch, metadata].filter(Boolean).join(' '))
    if (!name && words.some((word, index) => !counts[index] && !nameTokens.some(token => searchTokenMatches(token.text, word)))) continue
    const score = name?.score ?? sessionEvidenceScore(counts, together.has(row.session_id), phrased.has(row.session_id))
    matches.push({ sessionId: row.session_id, score, timestamp: row.last_activity_at, name })
  }
  if (!matches.length) for (const row of candidates) {
    const name = sessionNameScore({ id: row.session_id, title: row.custom_title, branch: row.branch, pullRequest: request.metadata?.get(row.session_id) }, words, true)
    if (name) matches.push({ sessionId: row.session_id, score: name.score, timestamp: row.last_activity_at, name })
  }
  matches.sort((a, b) => b.score - a.score || b.timestamp - a.timestamp || a.sessionId.localeCompare(b.sessionId))
  const page = matches.slice(request.offset, request.offset + request.limit)
  if (!page.length) return { sessions: [], total: matches.length }
  const passages = request.namesOnly ? [] : passageSchema.array().parse(await db.all(sql`
    SELECT best.session_id, best.source_session_id, best.position, best.timestamp, best.content, best.message_id, best.role FROM (
      SELECT t.session_id, t.position, CAST(${field('timestamp')} AS BIGINT) AS timestamp,
        COALESCE(${field('content')}, '') AS content, ${field('messageId')} AS message_id, ${field('role')} AS role,
        COALESCE(${field('sourceSessionId')}, t.session_id) AS source_session_id,
        ROW_NUMBER() OVER (PARTITION BY t.session_id ORDER BY CASE WHEN ${phrase} THEN 2 WHEN ${all} THEN 1 ELSE 0 END DESC, t.position DESC) AS n
      FROM session_transcripts t JOIN session_records ON ${visible}
      WHERE ${request.records} AND ${written}
        AND t.session_id IN (${sql.join(page.map(row => sql`${row.sessionId}`), sql`, `)})
        AND (${sql.join(words.map(inWord), sql` OR `)})
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

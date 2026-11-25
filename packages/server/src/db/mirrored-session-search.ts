import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { rankSessions } from '@solus/contracts/session-search'
import type { Db } from './database'
import type { SessionMatchPage, SessionMatchQuery } from './search-index'
import { ftsExactPhrase } from './fts'

const candidateSchema = z.object({ session_id: z.string(), custom_title: z.string().nullable(), branch: z.string().nullable(), last_activity_at: z.coerce.number() })
const countSchema = z.object({ session_id: z.string(), count: z.coerce.number() })
const passageSchema = z.object({ session_id: z.string(), source_session_id: z.string(), position: z.coerce.number(), timestamp: z.coerce.number().nullable(), content: z.string(), message_id: z.string().nullable(), role: z.string() })

/** Both database engines retrieve normalized words. The shared scorer owns order. */
export async function searchMirroredSessions(db: Db, request: SessionMatchQuery): Promise<SessionMatchPage> {
  const { query } = request
  if (query.isEmpty) return { sessions: [], total: 0 }
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
  // An optional filler word is in nearly every message and decides nothing;
  // only the phrase still holds it.
  const { required, words } = query
  const all = sql.join(required.map(inWord), sql` AND `)
  const phrase = sql`(' ' || t.search_text || ' ') LIKE ${`% ${words.join(' ')}${/^\d+$/.test(words.at(-1)!) ? ' ' : ''}%`}`
  const passageFields = sql`t.session_id, t.position, CAST(${field('timestamp')} AS BIGINT) AS timestamp,
    COALESCE(${field('content')}, '') AS content, ${field('messageId')} AS message_id, ${field('role')} AS role,
    COALESCE(${field('sourceSessionId')}, t.session_id) AS source_session_id`
  const exact = new Map<string, { count: number; newest: Array<z.infer<typeof passageSchema>> }>()
  if (!request.namesOnly && query.exactPhrase) {
    const normalized = words.join(' ')
    const match = db.engine === 'postgres'
      // Use the GIN index for whole words and search_text for adjacency.
      // Postgres truncates positions in a tsvector for long messages.
      ? sql`t.search @@ plainto_tsquery('simple', ${normalized})
          AND (' ' || t.search_text || ' ') LIKE ${`% ${normalized.replace(/[!%_]/g, '!$&')} %`} ESCAPE '!'`
      : sql`t.rowid IN (SELECT rowid FROM session_transcripts_fts WHERE session_transcripts_fts MATCH ${ftsExactPhrase(words)})`
    // Verify candidates against the original text in batches. A common
    // quoted word can match most of a person's history.
    const batchSize = 250
    let after = sql``
    for (;;) {
      const rows = passageSchema.array().parse(await db.all(sql`
        SELECT ${passageFields} FROM session_transcripts t JOIN session_records ON ${visible}
        WHERE ${request.records} AND ${written} AND ${match} ${after}
        ORDER BY t.session_id, t.position DESC
        LIMIT ${batchSize}
      `))
      for (const passage of rows) {
        if (!query.holdsEveryWord(passage.content)) continue
        let hits = exact.get(passage.session_id)
        if (!hits) exact.set(passage.session_id, hits = { count: 0, newest: [] })
        hits.count++
        if (hits.newest.length < 3) hits.newest.push(passage)
      }
      if (rows.length < batchSize) break
      const last = rows.at(-1)!
      after = sql`AND (t.session_id > ${last.session_id} OR (t.session_id = ${last.session_id} AND t.position < ${last.position}))`
    }
  }
  const readCounts = async (match: SQL) => new Map(countSchema.array().parse(await db.all(sql`
    SELECT t.session_id, COUNT(*) AS count FROM session_transcripts t
    JOIN session_records ON ${visible}
    WHERE ${request.records} AND ${written} AND ${match} GROUP BY t.session_id
  `)).map(row => [row.session_id, row.count]))
  const readWords = !request.namesOnly && !query.exactPhrase
  const perWord = readWords ? await Promise.all(required.map(word => readCounts(inWord(word)))) : []
  const together = readWords && required.length > 1 ? await readCounts(all) : new Map<string, number>()
  const phrased = readWords && words.length > 1 ? await readCounts(sql`${all} AND ${phrase}`) : new Map<string, number>()
  const matches = rankSessions(query, candidates.map(row => ({
    sessionId: row.session_id, title: row.custom_title, branch: row.branch, pullRequest: request.metadata?.get(row.session_id), lastActivity: row.last_activity_at,
  })), request.namesOnly ? null : {
    counts: candidate => query.exactPhrase ? [exact.get(candidate.sessionId)?.count ?? 0] : perWord.map(counts => counts.get(candidate.sessionId) ?? 0),
    together: candidate => exact.has(candidate.sessionId) || together.has(candidate.sessionId),
    phrase: candidate => exact.has(candidate.sessionId) || phrased.has(candidate.sessionId),
  }, Date.now()).map(({ candidate, score, name }) => ({ sessionId: candidate.sessionId, score, name }))
  const page = matches.slice(request.offset, request.offset + request.limit)
  if (!page.length) return { sessions: [], total: matches.length }
  const passages = !readWords ? [] : passageSchema.array().parse(await db.all(sql`
    SELECT best.session_id, best.source_session_id, best.position, best.timestamp, best.content, best.message_id, best.role FROM (
      SELECT ${passageFields},
        ROW_NUMBER() OVER (PARTITION BY t.session_id ORDER BY CASE WHEN ${phrase} THEN 2 WHEN ${all} THEN 1 ELSE 0 END DESC, t.position DESC) AS n
      FROM session_transcripts t JOIN session_records ON ${visible}
      WHERE ${request.records} AND ${written}
        AND t.session_id IN (${sql.join(page.map(row => sql`${row.sessionId}`), sql`, `)})
        AND (${sql.join(required.map(inWord), sql` OR `)})
    ) best WHERE best.n <= 3 ORDER BY best.session_id, best.n
  `))
  return {
    total: matches.length,
    sessions: page.map(row => ({ sessionId: row.sessionId, rank: -row.score, reason: row.name?.reason ?? { field: 'messages', text: '' },
      passages: (query.exactPhrase ? exact.get(row.sessionId)?.newest ?? [] : passages.filter(passage => passage.session_id === row.sessionId)).map(passage => ({
        position: passage.position, timestamp: passage.timestamp, content: passage.content,
        target: { sourceSessionId: passage.source_session_id, messageId: passage.message_id, role: passage.role, timestamp: passage.timestamp ?? 0, text: passage.content.slice(0, 256) },
      })),
    })),
  }
}

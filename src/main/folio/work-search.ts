import { getDb } from '../db'
import { sanitizeFtsQuery } from '../db/fts'
import { createLogger } from '../logger'
import { listWorks, loadWork } from './works'

const log = createLogger('folio', 'work-search.ts')

/**
 * Content search over works, across both storages:
 *   - `local` works live in the `works` table and are matched by the `works_fts`
 *     FTS5 index (kept live by triggers — see db/migrations.ts).
 *   - `project` works live as files under `<repo>/.solus/works`, so they are read
 *     and token-matched at search time. There are a handful per repo, so an index
 *     would cost more than it saves.
 */

export type WorkType = 'doc' | 'slides' | 'diagram'

export interface WorkSearchHit {
  id: string
  title: string
  type: WorkType
  storage: 'local' | 'project'
  cwd: string
  updatedAt: string
  snippet: string
}

const SNIPPET_RADIUS = 90

interface LocalHitRow {
  id: string
  title: string | null
  type: string | null
  cwd: string | null
  updated_at: number
  snippet: string | null
}

function workType(value: string | null | undefined): WorkType {
  return value === 'slides' || value === 'diagram' ? value : 'doc'
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Excerpt around the first occurrence of `token`, with `…` marking each side
 *  that was cut. Falls back to the head of the text when the token isn't there. */
function snippetAround(text: string, token: string): string {
  const at = text.toLowerCase().indexOf(token)
  if (at < 0) return oneLine(text.slice(0, SNIPPET_RADIUS * 2)) + (text.length > SNIPPET_RADIUS * 2 ? '…' : '')
  const start = Math.max(0, at - SNIPPET_RADIUS)
  const end = Math.min(text.length, at + token.length + SNIPPET_RADIUS)
  return `${start > 0 ? '…' : ''}${oneLine(text.slice(start, end))}${end < text.length ? '…' : ''}`
}

function searchLocalWorks(ftsQuery: string, type: WorkType | undefined, limit: number): WorkSearchHit[] {
  const params: Array<string | number> = [ftsQuery]
  if (type) params.push(type)
  params.push(limit)

  // Column -1 lets FTS5 pick the best-matching column for the snippet; the bm25
  // weights (work_id, title, content) rank a title hit above a body hit.
  const rows = getDb().prepare(`
    SELECT
      w.id,
      w.title,
      w.type,
      w.cwd,
      w.updated_at,
      snippet(works_fts, -1, '', '', '…', 64) AS snippet,
      bm25(works_fts, 0.0, 5.0, 1.0) AS rank
    FROM works_fts
    JOIN works w ON w.id = works_fts.work_id
    WHERE works_fts MATCH ?
    ${type ? 'AND w.type = ?' : ''}
    ORDER BY rank ASC
    LIMIT ?
  `).all(...params) as unknown as LocalHitRow[]

  return rows.map((row) => ({
    id: row.id,
    title: row.title ?? '',
    type: workType(row.type),
    storage: 'local' as const,
    cwd: row.cwd ?? '~',
    updatedAt: new Date(row.updated_at).toISOString(),
    snippet: oneLine(row.snippet ?? ''),
  }))
}

/** Project-storage works matching every query token (FTS-style AND over
 *  title+content), newest first. Same rule as `read_session`'s `match` mode. */
async function searchProjectWorks(
  tokens: string[],
  type: WorkType | undefined,
  cwd: string | undefined,
): Promise<WorkSearchHit[]> {
  const metas = (await listWorks(cwd)).filter(
    (meta) => meta.storage?.kind === 'project' && (!type || meta.type === type),
  )

  const hits: WorkSearchHit[] = []
  for (const meta of metas) {
    const work = await loadWork(meta.id, cwd)
    if (!work) continue
    const title = work.title ?? ''
    const haystack = `${title}\n${work.content}`.toLowerCase()
    if (!tokens.every((token) => haystack.includes(token))) continue
    const inBody = tokens.find((token) => work.content.toLowerCase().includes(token))
    hits.push({
      id: work.id,
      title,
      type: workType(work.type),
      storage: 'project',
      cwd: work.cwd ?? '~',
      updatedAt: work.updatedAt,
      snippet: inBody ? snippetAround(work.content, inBody) : oneLine(title),
    })
  }
  return hits.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** Local hits first (relevance-ordered), then project hits (newest first),
 *  capped at `limit`. */
export async function searchWorks(
  query: string,
  opts: { type?: WorkType; cwd?: string; limit: number },
): Promise<WorkSearchHit[]> {
  const ftsQuery = sanitizeFtsQuery(query)
  if (!ftsQuery) return []

  let local: WorkSearchHit[] = []
  try {
    local = searchLocalWorks(ftsQuery, opts.type, opts.limit)
  } catch (err: any) {
    log.error(`searchLocalWorks failed: ${String(err)}`)
  }

  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  let project: WorkSearchHit[] = []
  try {
    project = await searchProjectWorks(tokens, opts.type, opts.cwd)
  } catch (err: any) {
    log.error(`searchProjectWorks failed: ${String(err)}`)
  }

  return [...local, ...project].slice(0, opts.limit)
}

import { z } from 'zod'
import type { CodeIntelDocsSummary, CodeIntelExternalDocumentation, MdnArticlePath } from '@solus/contracts/code-intel'

/**
 * MDN, read on the host and handed to the card as one sentence. The renderer
 * cannot reach developer.mozilla.org itself — a paired web client is a
 * different origin from the host and a different network from the project — so
 * the fetch, the HTML reduction, and the cache all live here.
 */

const MDN_ORIGIN = 'https://developer.mozilla.org'
/** The summary fills a description that is already on screen; past this the
 *  reader has moved on and an empty description is the honest answer. */
const REQUEST_TIMEOUT_MS = 6_000
/** MDN pages change on a release cadence, not a session one. */
const CACHE_TTL_MS = 6 * 60 * 60_000
const MAX_CACHED = 200

const documentSchema = z.object({
  doc: z.object({
    title: z.string().nullish(),
    body: z
      .array(
        z.object({
          type: z.string(),
          value: z.object({ content: z.string().nullish() }).nullish(),
        }),
      )
      .nullish(),
  }),
})

const searchSchema = z.object({
  documents: z
    .array(z.object({ mdn_url: z.string(), title: z.string().nullish(), summary: z.string().nullish() }))
    .nullish(),
})

const ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
])

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(parseInt(body.slice(2), 16))
    if (body.startsWith('#')) return String.fromCodePoint(Number(body.slice(1)))
    return ENTITIES.get(body) ?? whole
  })
}

/**
 * The page's opening sentence. MDN's lead section is HTML, and the card renders
 * text into a line or two of description, so this takes the first paragraph and
 * flattens it. Code samples are skipped: a `<pre>` block is not a summary.
 */
export function leadParagraphOf(html: string): string {
  const withoutSamples = html.replace(/<pre\b[\s\S]*?<\/pre>/gi, '')
  const blocks = /<p\b[^>]*>([\s\S]*?)<\/p>/gi
  let block: RegExpExecArray | null
  while ((block = blocks.exec(withoutSamples)) !== null) {
    const text = decodeEntities(block[1]!.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
    if (text) return text
  }
  return ''
}

export function parseMdnArticle(article: MdnArticlePath, payload: unknown): CodeIntelDocsSummary | null {
  const parsed = documentSchema.safeParse(payload)
  if (!parsed.success) return null
  const doc = parsed.data.doc
  for (const entry of doc.body ?? []) {
    if (entry.type !== 'prose' || !entry.value?.content) continue
    const summary = leadParagraphOf(entry.value.content)
    // A page whose lead is a compatibility table or a redirect note describes
    // nothing; the card shows no description rather than a stray fragment.
    if (summary) return { title: doc.title?.trim() ?? '', summary, url: `${MDN_ORIGIN}/${article}` }
  }
  return null
}

/** The best match's own summary. MDN's search returns one already flattened,
 *  so the top hit answers in a single request. */
export function parseMdnSearch(payload: unknown): CodeIntelDocsSummary | null {
  const parsed = searchSchema.safeParse(payload)
  if (!parsed.success) return null
  const best = parsed.data.documents?.[0]
  const summary = best?.summary?.replace(/\s+/g, ' ').trim()
  if (!best || !summary) return null
  return { title: best.title?.trim() ?? '', summary, url: `${MDN_ORIGIN}/${best.mdn_url.replace(/^\//, '')}` }
}

interface CacheEntry {
  value: CodeIntelDocsSummary
  at: number
}

/** One reader per server. Two clicks on `querySelector` cost one fetch. */
export class MdnReader {
  private readonly cache = new Map<string, CacheEntry>()

  async summaryFor(reference: CodeIntelExternalDocumentation): Promise<CodeIntelDocsSummary> {
    const key = reference.kind === 'article' ? `article:${reference.article}` : `search:${reference.query}`
    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.at <= CACHE_TTL_MS) return cached.value

    const summary =
      reference.kind === 'article'
        ? parseMdnArticle(reference.article, await this.fetchJson(articleUrl(reference.article)))
        : parseMdnSearch(await this.fetchJson(searchUrl(reference.query)))
    if (!summary) throw new Error('MDN describes no page for this symbol.')

    if (this.cache.size >= MAX_CACHED) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) this.cache.delete(oldest)
    }
    this.cache.set(key, { value: summary, at: Date.now() })
    return summary
  }

  private async fetchJson(url: string): Promise<unknown> {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.status === 404) throw new Error('MDN has no page for this symbol.')
    if (!response.ok) throw new Error(`MDN answered ${response.status}.`)
    return response.json()
  }
}

function articleUrl(article: MdnArticlePath): string {
  return `${MDN_ORIGIN}/${article}/index.json`
}

function searchUrl(query: string): string {
  return `${MDN_ORIGIN}/api/v1/search?q=${encodeURIComponent(query)}&locale=en-US`
}

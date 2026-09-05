import type {
  BrowserCookieImportResult,
  BrowserCookieSource,
  BrowserPage,
} from "@solus/contracts/browser-types"

/** How the profile surfaces read: every line is a sentence a user can act on. */

/** The project a page's profiles belong to. A device target has none, and shares
 *  the hostless jar with every other page that has none. */
export function projectRootOf(page: BrowserPage): string | undefined {
  return page.target.kind === "url" ? page.target.projectRoot : undefined
}

/** Which profile this is, in the words a person picking one needs. A blocked
 *  source states what would have to change instead of a count. */
export function sourceDetail(source: BrowserCookieSource, now = Date.now()): string {
  if (source.unavailable) return source.unavailable
  const cookies = `${source.importable} cookie${source.importable === 1 ? "" : "s"}`
  if (source.lastUsedAt === undefined) return cookies
  const days = Math.floor((now - source.lastUsedAt) / 86_400_000)
  if (days <= 0) return `${cookies} · used today`
  if (days === 1) return `${cookies} · used yesterday`
  if (days < 30) return `${cookies} · used ${days} days ago`
  return `${cookies} · last used over a month ago`
}

/** The sources a person can actually choose, and the ones they cannot. */
export interface CookieSourceGroups {
  available: BrowserCookieSource[]
  /** Found on the host, and refused by it. Shown with the reason. */
  blocked: BrowserCookieSource[]
}

export function partitionSources(sources: BrowserCookieSource[]): CookieSourceGroups {
  return {
    available: sources.filter((source) => !source.unavailable),
    blocked: sources.filter((source) => !!source.unavailable),
  }
}

/** What an import actually did, with every rejection named. */
export function importSummary(result: BrowserCookieImportResult): string {
  const parts: string[] = []
  if (result.skipped.expired) parts.push(`${result.skipped.expired} expired`)
  if (result.skipped.partitioned) parts.push(`${result.skipped.partitioned} partitioned`)
  if (result.skipped.container) parts.push(`${result.skipped.container} in containers`)
  if (result.skipped.encrypted) parts.push(`${result.skipped.encrypted} the host could not decrypt`)
  if (result.skipped.unsupported) parts.push(`${result.skipped.unsupported} unsupported`)
  if (result.failed) parts.push(`${result.failed} refused by the browser`)
  const skipped = parts.length ? ` Skipped ${parts.join(", ")}.` : ""
  return `${result.imported} of ${result.read} cookies imported.${skipped}`
}

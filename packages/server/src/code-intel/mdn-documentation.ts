import type { CodeIntelExternalDocumentation, MdnArticlePath } from '@solus/contracts/code-intel'
import { symbolOwnerName } from './symbol-name'

const MDN_URL_PATTERN = /https:\/\/developer\.mozilla\.org\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?docs\/[^\s)]+/
const TYPESCRIPT_STANDARD_LIBRARY_PREFIX = 'scip-typescript npm typescript '
const LOCALE_SEGMENT = /^[a-z]{2}(?:-[A-Z]{2})?$/
/** MDN serves every article in English; a translated locale can be missing. */
const DEFAULT_LOCALE = 'en-US'

function mdnUrlIn(documentation: string[]): string | null {
  for (const paragraph of documentation) {
    const match = MDN_URL_PATTERN.exec(paragraph)
    if (match) return match[0]
  }
  return null
}

/** `es\d+`, not `es\d`: the year-named libraries — `lib.es2015.core.d.ts` and
 *  its siblings — hold most of the modern standard library, `Number.parseInt`
 *  and `Object.entries` among them. Only `lib.es5` has a single-digit name. */
function isWebOrJavaScriptLibrarySymbol(symbol: string): boolean {
  if (!symbol.startsWith(TYPESCRIPT_STANDARD_LIBRARY_PREFIX)) return false
  return /(?:^|[\/.`])lib\.(?:dom|dom\.iterable|webworker|webworker\.iterable|es\d+|esnext)(?:\.|`|\/)/.test(symbol)
}

/**
 * The path MDN's own APIs key on. TypeScript's DOM declarations omit the
 * locale, and both APIs need one, so an unlocalized link is read as English.
 * Anything that is not an MDN document link has no article to read.
 */
export function mdnArticlePathFrom(url: string): MdnArticlePath | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.hostname !== 'developer.mozilla.org') return null
  const segments = parsed.pathname.split('/').filter(Boolean)
  const [first, ...rest] = segments
  if (first === undefined) return null
  const withLocale = LOCALE_SEGMENT.test(first) ? segments : [DEFAULT_LOCALE, first, ...rest]
  if (withLocale[1] !== 'docs' || withLocale.length < 3) return null
  return withLocale.join('/')
}

/**
 * TypeScript's DOM declarations carry exact MDN links. Some JavaScript
 * standard-library declarations do not, so those carry a search the card runs
 * on demand instead of a guessed article path. This keeps every platform symbol
 * useful without sending package symbols to MDN by mistake.
 */
export function mdnDocumentationFor(
  symbol: string,
  displayName: string,
  documentation: string[],
): CodeIntelExternalDocumentation | null {
  const exactUrl = mdnUrlIn(documentation)
  const article = exactUrl ? mdnArticlePathFrom(exactUrl) : null
  if (article) return { provider: 'mdn', kind: 'article', article }
  if (!isWebOrJavaScriptLibrarySymbol(symbol)) return null
  return { provider: 'mdn', kind: 'search', query: mdnSearchQuery(symbol, displayName) }
}

/**
 * MDN's search ranks a phrase, not a keyword plus a topic word: "map JavaScript"
 * returns the JavaScript landing pages, while "Array map" returns
 * `Array.prototype.map()`. So the query is the symbol's owner and its name —
 * the two words a reader looking for the page would have typed. A symbol with
 * no owner, like `parseInt`, is already unambiguous on its own.
 */
export function mdnSearchQuery(symbol: string, displayName: string): string {
  const owner = symbolOwnerName(symbol)
  return owner ? `${owner} ${displayName}` : displayName
}

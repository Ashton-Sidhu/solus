import type {
  BrowserCookieBrowser,
  BrowserCookieImportResult,
  BrowserCookieSource,
  BrowserOpenRequest,
  BrowserPage,
  BrowserTarget,
} from "@solus/contracts/browser-types"

/** How the profile surfaces read: every line is a sentence a user can act on. */

/** The project a target's profiles belong to. A device target has none, and
 *  shares the hostless jar with every other page that has none. */
export function targetProjectRoot(target: BrowserTarget): string | undefined {
  return target.kind === "url" ? target.projectRoot : undefined
}

export function projectRootOf(page: BrowserPage): string | undefined {
  return targetProjectRoot(page.target)
}

/**
 * What to ask the host for when a page opens from the picker.
 *
 * A profile is chosen against one project's set, and its id means nothing in
 * another — the host would refuse it. So the choice rides along only for a
 * target in the project it was made for; any other target takes that project's
 * own default, which the page's chip then states.
 */
export function openRequestFor(
  target: BrowserTarget,
  chosenProjectRoot: string | undefined,
  chosenProfileId: string | null,
): BrowserOpenRequest {
  const request: BrowserOpenRequest = { target }
  if (chosenProfileId && targetProjectRoot(target) === chosenProjectRoot) {
    request.profileId = chosenProfileId
  }
  return request
}

/** What a profile row means, in the two places the chip appears. On a page the
 *  identity is fixed (ADR 0023), so another row is a second page; in the picker
 *  the row is the identity the page about to open will take. */
export type ProfileSelection = "page" | "next"

export function profileRowTitle(
  selection: ProfileSelection,
  isSelected: boolean,
  name: string,
): string {
  if (selection === "page") {
    return isSelected
      ? `This page is signed in as ${name}`
      : `Open this address again as ${name}`
  }
  return isSelected ? `The next page opens as ${name}` : `Open the next page as ${name}`
}

const BROWSER_NAMES: Record<BrowserCookieBrowser, string> = {
  firefox: "Firefox",
  chrome: "Chrome",
  safari: "Safari",
}

export function browserName(browser: BrowserCookieBrowser): string {
  return BROWSER_NAMES[browser]
}

function cookieCount(count: number): string {
  return `${count.toLocaleString()} cookie${count === 1 ? "" : "s"}`
}

/** Which profile this is, in the words a person picking one needs. */
export function sourceDetail(source: BrowserCookieSource, now = Date.now()): string {
  if (source.unavailable) return source.unavailable
  if (source.importable === 0) return "Nothing to import"
  const cookies = cookieCount(source.importable)
  if (source.lastUsedAt === undefined) return cookies
  const days = Math.floor((now - source.lastUsedAt) / 86_400_000)
  if (days <= 0) return `${cookies} · used today`
  if (days === 1) return `${cookies} · used yesterday`
  if (days < 30) return `${cookies} · used ${days} days ago`
  return `${cookies} · not used this month`
}

/**
 * Where the user is in granting access to a blocked source. The host opened the
 * operating system's setting; what remains is on the user, and the row says so
 * in the words for that step.
 */
export type AccessStep = "idle" | "requested" | "rechecked"

export function blockedSourceDetail(source: BrowserCookieSource, step: AccessStep): string {
  if (step === "requested") return "Allow Solus in the settings that opened, then check again."
  if (step === "rechecked") return "Still blocked. Restart Solus after allowing it, then check again."
  return source.unavailable ?? "Not available on this host."
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

/** What an import actually did: the number that matters first, every rejection
 *  named after it. */
export interface ImportSummary {
  headline: string
  detail: string | null
}

export function importSummary(result: BrowserCookieImportResult): ImportSummary {
  const parts: string[] = []
  if (result.skipped.expired) parts.push(`${result.skipped.expired} expired`)
  if (result.skipped.partitioned) parts.push(`${result.skipped.partitioned} partitioned`)
  if (result.skipped.container) parts.push(`${result.skipped.container} in containers`)
  if (result.skipped.encrypted) parts.push(`${result.skipped.encrypted} the host could not decrypt`)
  if (result.skipped.unsupported) parts.push(`${result.skipped.unsupported} unsupported`)
  if (result.failed) parts.push(`${result.failed} refused by the browser`)
  return {
    headline: result.imported === 0 ? "No cookies imported" : `${cookieCount(result.imported)} imported`,
    detail: parts.length ? `Skipped ${parts.join(", ")}.` : null,
  }
}

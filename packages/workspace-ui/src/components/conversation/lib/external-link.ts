/** An address a browser page can render. `mailto:`, `file:` and every other
 *  scheme are excluded here rather than left to fail later: an affordance that
 *  opens nothing is worse than no affordance. */
export function isWebUrl(href: string): boolean {
  try {
    const { protocol } = new URL(href)
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}

export function faviconUrlForHref(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return new URL("/favicon.ico", url.origin).href;
  } catch {
    return null;
  }
}

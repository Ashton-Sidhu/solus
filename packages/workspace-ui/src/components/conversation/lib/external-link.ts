/** An address a browser page can render. `mailto:`, `file:` and every other
 *  scheme are excluded here rather than left to fail later: an affordance that
 *  opens nothing is worse than no affordance. */
function isWebUrl(href: string): boolean {
  try {
    const { protocol } = new URL(href)
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}

/** Selected text must be one complete web address, not prose containing one. */
export function selectedWebUrl(text: string): string | null {
  const selected = text.trim();
  if (!selected || /\s/.test(selected)) return null;
  const href = /^www\./i.test(selected) ? `https://${selected}` : selected;
  if (!/^https?:\/\//i.test(href)) return null;
  return isWebUrl(href) ? href : null;
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

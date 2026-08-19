export function faviconUrlForHref(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return new URL("/favicon.ico", url.origin).href;
  } catch {
    return null;
  }
}

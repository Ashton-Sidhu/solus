/**
 * The app links of the outside app guides (`OUTSIDE_APP_GUIDES`) that the
 * desktop app may hand to the operating system: Grok Bot's prompt link and
 * Cursor's MCP settings link, in exactly the forms the guides make. Other deep
 * links of these apps stay out.
 */
export function outsideAppLinkUrl(href: string): string | null {
  let url: URL
  try { url = new URL(href.trim()) } catch { return null }
  if (url.username || url.password || url.port || url.hash) return null
  const scheme = url.protocol.toLowerCase()
  if (scheme === 'grokbot:') {
    const keys = [...url.searchParams.keys()]
    return url.host === 'app' && url.pathname === '/v1/prompt' && keys.length === 1 && keys[0] === 'text' ? href.trim() : null
  }
  if (scheme === 'cursor:') {
    return url.host === 'anysphere.cursor-deeplink' && url.pathname === '/settings/mcp' && !url.search ? href.trim() : null
  }
  return null
}

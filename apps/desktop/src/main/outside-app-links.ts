import { z } from 'zod'

/**
 * The app links of the outside app guides (`OUTSIDE_APP_GUIDES`) that the
 * desktop app may hand to the operating system: Grok Bot's prompt link and
 * Cursor's MCP install link, in exactly the forms the guides make. Other deep
 * links of these apps stay out.
 */
export function outsideAppLinkUrl(href: string): string | null {
  let url: URL
  try { url = new URL(href.trim()) } catch { return null }
  if (url.username || url.password || url.port || url.hash) return null
  const scheme = url.protocol.toLowerCase()
  const keys = [...url.searchParams.keys()]
  if (scheme === 'grokbot:') {
    return url.host === 'app' && url.pathname === '/v1/prompt' && keys.length === 1 && keys[0] === 'text' ? href.trim() : null
  }
  if (scheme === 'cursor:') {
    const named = keys.length === 2 && keys.includes('name') && keys.includes('config')
    return url.host === 'anysphere.cursor-deeplink' && url.pathname === '/mcp/install' && named && isUrlOnlyConfig(url.searchParams.get('config') ?? '') ? href.trim() : null
  }
  return null
}

/**
 * A Cursor install config may also name a command for Cursor to run. The guide's
 * config names only the server's web address, so only that passes. The base64
 * must be canonical, so Cursor's decoder cannot read other bytes than this one.
 */
function isUrlOnlyConfig(base64: string): boolean {
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.toString('base64') !== base64) return false
  try {
    return urlOnlyConfigSchema.safeParse(JSON.parse(bytes.toString('utf8'))).success
  } catch {
    return false
  }
}

const urlOnlyConfigSchema = z.object({ url: z.url({ protocol: /^https?$/ }) }).strict()

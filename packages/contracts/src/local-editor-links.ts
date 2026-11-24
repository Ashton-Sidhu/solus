/**
 * Editors that open a local file from `<scheme>://file/<absolute path>[:line[:col]]`.
 * Agents write these links in chat. The client opens them with the operating
 * system, so they reach the editor on the machine that shows the link.
 */
const LOCAL_EDITOR_FILE_SCHEMES = new Set(['vscode', 'vscode-insiders', 'vscodium', 'cursor'])

/**
 * The link with its scheme in lower case when it is a local editor file link,
 * else null. Only the `file` host, with no user, password, or port, and a path
 * is accepted, so an editor's other deep links (prompts, clones, remotes) stay out.
 */
export function localEditorFileUrl(href: string): string | null {
  let url: URL
  try {
    url = new URL(href.trim())
  } catch {
    return null
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase()
  if (!LOCAL_EDITOR_FILE_SCHEMES.has(scheme)) return null
  if (url.host !== 'file' || url.username || url.password || url.pathname.length <= 1) return null
  return `${scheme}:${href.trim().slice(url.protocol.length)}`
}

/** Only the SSH link forms made by the remote Open in action may reach the OS. */
export function remoteEditorFileUrl(href: string): string | null {
  let url: URL
  try { url = new URL(href.trim()) } catch { return null }
  if (url.username || url.password || url.port || url.hash) return null
  const scheme = url.protocol.slice(0, -1).toLowerCase()
  if (scheme === 'zed') {
    return url.host === 'ssh' && !url.search && /^\/(?:(?:[A-Za-z0-9._-]|%2b)+@)?[A-Za-z0-9][A-Za-z0-9._-]*\//i.test(url.pathname)
      ? href.trim() : null
  }
  if (scheme !== 'vscode' && scheme !== 'cursor') return null
  return url.host === 'vscode-remote' && (!url.search || url.search === '?windowId=_blank')
    && /^\/ssh-remote\+(?:(?:[A-Za-z0-9._-]|%2b)+%40)?[A-Za-z0-9][A-Za-z0-9._-]*\//i.test(url.pathname)
    ? href.trim() : null
}

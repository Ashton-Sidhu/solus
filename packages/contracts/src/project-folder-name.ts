/**
 * The folder name a project gets on its host, from what the user typed or the
 * repository's name. Shared so the client previews the same path the host
 * creates: "My Website" becomes `My-Website`, never a path of its own.
 */
export function safeProjectDirName(raw: string): string {
  const base = raw.trim().replace(/\.git$/i, '')
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  if (!cleaned || /^\.+$/.test(cleaned)) return 'project'
  return cleaned.startsWith('.') ? `project-${cleaned.slice(1)}` : cleaned
}

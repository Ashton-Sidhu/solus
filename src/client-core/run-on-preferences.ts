import { LOCAL_SERVER_ID } from './server-registry'

const STORAGE_KEY = 'solus.runOnHostsByRepo'

function loadPreferences(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    )
  } catch {
    return {}
  }
}

export function preferredRunOnHost(repoKey: string | null | undefined): string {
  if (!repoKey) return LOCAL_SERVER_ID
  return loadPreferences()[repoKey.toLowerCase()] ?? LOCAL_SERVER_ID
}

export function rememberRunOnHost(repoKey: string | null | undefined, serverId: string): void {
  if (!repoKey) return
  const preferences = loadPreferences()
  preferences[repoKey.toLowerCase()] = serverId || LOCAL_SERVER_ID
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
}

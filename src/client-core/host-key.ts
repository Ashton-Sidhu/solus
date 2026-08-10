const HOST_KEY_SEPARATOR = '\0'

/** A path alone is display data, not identity. */
export function hostKey(serverId: string, path: string): string {
  return `${serverId}${HOST_KEY_SEPARATOR}${path}`
}

export function splitHostKey(key: string): { serverId: string; path: string } {
  const separatorIndex = key.indexOf(HOST_KEY_SEPARATOR)
  if (separatorIndex < 0) throw new Error('Host key has no separator')
  return {
    serverId: key.slice(0, separatorIndex),
    path: key.slice(separatorIndex + HOST_KEY_SEPARATOR.length),
  }
}

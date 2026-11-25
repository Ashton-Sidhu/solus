/**
 * One saved version of an artifact work, as a page a client loads from a
 * signed host URL (`docs/plans/mobile-artifact-pages.md`).
 */

/** Frame heights the host measured for one page: one per frame width, and the tallest. */
export interface ArtifactLayout {
  height: number
  heights?: Array<readonly [width: number, height: number]>
}

const PREFIX = 'artifact:'

/** The asset id a client asks `assetCreateUrl` to sign for this version. */
export function artifactPageAttachmentId(workId: string, contentVersion: number): string {
  return `${PREFIX}${workId}:${contentVersion}`
}

/** The work version an artifact page id names, or null when it names none. */
export function readArtifactPageAttachmentId(id: string): { workId: string; contentVersion: number } | null {
  if (!id.startsWith(PREFIX) || id.length > 256) return null
  const at = id.lastIndexOf(':')
  const workId = id.slice(PREFIX.length, at)
  const contentVersion = Number(id.slice(at + 1))
  return workId && Number.isInteger(contentVersion) && contentVersion > 0 ? { workId, contentVersion } : null
}

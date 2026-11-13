import { allSessionArtifacts, type SessionArtifact, type SessionArtifacts } from '@solus/contracts/session-artifacts'

/** One name per artifact, stable across reads: the record it stands for. */
export function artifactKey(artifact: SessionArtifact): string {
  switch (artifact.kind) {
    case 'pull-request':
      return `pull-request:${artifact.link.repository}#${artifact.link.number}`
    case 'work':
      return `work:${artifact.workId}`
    case 'file':
    case 'image':
      return `${artifact.kind}:${artifact.hostId}:${artifact.path}`
    case 'automation':
      return `automation:${artifact.hostId}:${artifact.automationId}`
    case 'app':
      return `app:${artifact.hostId}:${artifact.appId}`
  }
}

/** When the artifact was linked. */
export function artifactLinkedAt(artifact: SessionArtifact): number {
  return artifact.kind === 'pull-request' ? artifact.link.linkedAt : artifact.linkedAt
}

/** The newest artifact in `next` that `previous` did not have; null when none was added. */
export function newestAddedKey(previous: SessionArtifacts, next: SessionArtifacts): string | null {
  const held = new Set(allSessionArtifacts(previous).map(artifactKey))
  let newest: SessionArtifact | null = null
  for (const artifact of allSessionArtifacts(next)) {
    if (held.has(artifactKey(artifact))) continue
    if (!newest || artifactLinkedAt(artifact) > artifactLinkedAt(newest)) newest = artifact
  }
  return newest ? artifactKey(newest) : null
}

/** Whether a list names a session: as its own, or as one of the sessions it started. */
export function listsSession(owner: string, artifacts: SessionArtifacts | undefined, sessionId: string): boolean {
  return owner === sessionId || !!artifacts?.children.some((group) => group.sessionId === sessionId)
}

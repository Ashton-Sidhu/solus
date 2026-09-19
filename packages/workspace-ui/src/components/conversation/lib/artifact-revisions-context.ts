import { getContext, setContext } from 'svelte'
import type { ArtifactRevision } from './artifact-revisions'

const revisionsKey = Symbol('artifact-revisions')
const messageKey = Symbol('artifact-message')

export function provideArtifactRevisions(read: () => Map<string, ArtifactRevision[]>): void {
  setContext(revisionsKey, read)
}

export function getArtifactRevisions(): (() => Map<string, ArtifactRevision[]>) | undefined {
  return getContext(revisionsKey)
}

export function provideArtifactMessage(read: () => string | undefined): void {
  setContext(messageKey, read)
}

export function getArtifactMessage(): (() => string | undefined) | undefined {
  return getContext(messageKey)
}

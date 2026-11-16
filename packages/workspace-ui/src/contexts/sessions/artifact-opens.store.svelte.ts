import { SvelteMap } from 'svelte/reactivity'
import type { SessionArtifact } from '@solus/contracts/session-artifacts'
import { ArtifactOpenLog, recentArtifactKey, type ArtifactOpenStorage } from '@solus/client-core/recent-artifacts'

function deviceStorage(): ArtifactOpenStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/**
 * When this device last opened each artifact, which orders the Threads
 * surface's row (docs/plans/session-artifacts.md decision 17). It is kept on
 * this device only.
 */
class ArtifactOpensStore {
  private readonly log = new ArtifactOpenLog(deviceStorage())
  /** This window's opens, which a reader subscribes to by item; the log holds the rest. */
  private readonly opened = new SvelteMap<string, number>()

  openedAt(artifact: SessionArtifact): number | null {
    return this.opened.get(recentArtifactKey(artifact)) ?? this.log.openedAt(artifact)
  }

  record(artifact: SessionArtifact, at = Date.now()): void {
    this.log.record(artifact, at)
    this.opened.set(recentArtifactKey(artifact), at)
  }
}

export const artifactOpensStore = new ArtifactOpensStore()

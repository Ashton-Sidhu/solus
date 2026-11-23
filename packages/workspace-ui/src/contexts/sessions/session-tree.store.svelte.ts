import { SvelteMap } from 'svelte/reactivity'
import type { SessionTree } from '@solus/contracts/session-digest'
import { serverConnections } from '@solus/client-core/server-connections'
import { localApi } from '@solus/client-core/local-api'
import { EMPTY_SESSION_TREE_VIEW, SessionTreeWatch, type SessionTreeView } from '@solus/client-core/session-tree-watch'

interface Followed {
  serverId: string
  watch: SessionTreeWatch
  holders: number
}

/**
 * Each shown session's tree (docs/plans/session-digests.md): the session and
 * every session below it, with each one's record, digest, and artifacts, read
 * from the host that runs it. A surface holds a session with `retain` while it
 * shows it; the last release stops following it. The host's events keep a
 * held tree current, and a reconnect reads it again.
 */
class SessionTreeStore {
  private readonly views = new SvelteMap<string, SessionTreeView>()
  private readonly followed = new Map<string, Followed>()
  private readonly treeReaders = new Set<(serverId: string, tree: SessionTree) => void>()
  private stopReadiness: (() => void) | null = null

  onTreeRead(listener: (serverId: string, tree: SessionTree) => void): () => void {
    this.treeReaders.add(listener)
    return () => this.treeReaders.delete(listener)
  }

  /** Follow a session's tree until the returned release. */
  retain(serverId: string, sessionId: string): () => void {
    this.watchReadiness()
    let held = this.followed.get(sessionId)
    if (held && held.serverId !== serverId) {
      // The session moved to another host: follow it there.
      held.watch.stop()
      this.followed.delete(sessionId)
      this.views.delete(sessionId)
      held = undefined
    }
    if (!held) {
      const watch = new SessionTreeWatch({
        // Through the host's current connection, also after a reconnect.
        api: {
          sessionTree: (id) => {
            const platform = localApi.getPlatform?.()
            const api = serverConnections.apiFor(serverId)
            return platform && platform !== 'web' ? api.sessionTree(id, true) : api.sessionTree(id)
          },
        },
        events: serverConnections.eventsFor(serverId),
        sessionId,
        onChange: (view) => {
          this.views.set(sessionId, view)
          if (view.tree && !view.loading && !view.stale) {
            for (const listener of this.treeReaders) listener(serverId, view.tree)
          }
        },
      })
      held = { serverId, watch, holders: 0 }
      this.followed.set(sessionId, held)
      watch.start()
    }
    held.holders += 1
    const holding = held
    let released = false
    return () => {
      if (released) return
      released = true
      holding.holders -= 1
      if (holding.holders > 0 || this.followed.get(sessionId) !== holding) return
      holding.watch.stop()
      this.followed.delete(sessionId)
      this.views.delete(sessionId)
    }
  }

  /** The last tree read for a held session; null before its first answer. */
  treeFor(sessionId: string): SessionTree | null {
    return this.views.get(sessionId)?.tree ?? null
  }

  viewFor(sessionId: string, serverId?: string): SessionTreeView {
    const view = this.views.get(sessionId)
    if (serverId !== undefined && this.followed.get(sessionId)?.serverId !== serverId) return EMPTY_SESSION_TREE_VIEW
    return view ?? EMPTY_SESSION_TREE_VIEW
  }

  /** Read a held session's tree again: the retry after a failed read. */
  reload(sessionId: string, serverId?: string): void {
    const held = this.followed.get(sessionId)
    if (held && (serverId === undefined || held.serverId === serverId)) void held.watch.refresh()
  }

  private watchReadiness(): void {
    if (this.stopReadiness) return
    this.stopReadiness = serverConnections.onReadinessChange((serverId, status) => {
      if (status !== 'ready') return
      for (const held of this.followed.values()) {
        if (held.serverId === serverId) void held.watch.refresh()
      }
    })
  }
}

export const sessionTreeStore = new SessionTreeStore()

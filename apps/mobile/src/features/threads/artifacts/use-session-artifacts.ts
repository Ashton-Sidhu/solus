import { useEffect } from 'react'
import { useApp, useListened } from '../../../app/app-context'
import type { SolusApp } from '../../../app/solus-app'
import { threadKey } from '../thread-directory'
import { SessionArtifactsFeed, type SessionArtifactsSnapshot } from './session-artifacts-feed'

/** One feed per thread, shared by its header and its Artifacts screen. */
const feeds = new Map<string, SessionArtifactsFeed>()

export function sessionArtifactsFeed(app: SolusApp, hostId: string, sessionId: string): SessionArtifactsFeed {
  const key = threadKey(hostId, sessionId)
  let feed = feeds.get(key)
  if (!feed) {
    feed = new SessionArtifactsFeed(async () => {
      const connection = app.connections.connection(hostId)
      if (!connection) throw new Error('This host is not connected.')
      return connection.api.sessionArtifactsList(sessionId)
    })
    feeds.set(key, feed)
  }
  return feed
}

export interface SessionArtifactsView {
  readonly feed: SessionArtifactsFeed
  readonly snapshot: SessionArtifactsSnapshot
}

/**
 * A thread's artifacts, read when its host is ready. `follow` also reads them
 * again on each `session.artifactsChanged` for the thread: the open thread
 * follows, so the entry is marked while the person reads the conversation.
 */
export function useSessionArtifacts(hostId: string, sessionId: string, follow: boolean): SessionArtifactsView {
  const app = useApp()
  const feed = sessionArtifactsFeed(app, hostId, sessionId)
  const readiness = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness)
  useEffect(() => {
    const connection = app.connections.connection(hostId)
    if (readiness !== 'ready' || !connection) return
    void feed.load()
    if (!follow) return
    return connection.events.subscribe('session.artifactsChanged', (event) => {
      if (event.sessionId === sessionId) void feed.changed()
    })
  }, [app, feed, follow, hostId, readiness, sessionId])
  return { feed, snapshot: useListened(feed.changes, () => feed.snapshot) }
}

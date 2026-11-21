import { sessionCloudReadSource, sessionCloudReadView, type SessionCloudReadView } from '@solus/client-core/session-cloud-read'
import type { HostReadinessState } from '@solus/client-core/host-readiness'
import { useCallback, useEffect, useMemo } from 'react'

import { useApp, useListened } from '../../app/app-context'
import { conversationIdOf, type ConversationMeta, type ConversationStore } from '../conversation/conversation-store'
import { cloudReadProgress, cloudReadView, type CloudReadView } from './lib/cloud-read-view'

/**
 * The session's copy from Solus Cloud on this thread, while no host that holds
 * it is online (docs/plans/portable-sessions-cloud.md, Phase 5B): its state,
 * from what this phone knows now, and its action. The read starts here when
 * the copy applies: the phone asks the Solus API and takes what the transcript
 * mirror answers. A host's history replaces the copy in the controller. Null
 * when a host shows the conversation.
 */
export function useCloudRead(props: {
  readonly store: ConversationStore
  readonly meta: ConversationMeta
  readonly hostReadiness: HostReadinessState
  readonly hostLabel: string
  readonly onFollowHost?: (hostId: string) => ConversationStore | null
}): { view: CloudReadView; onAction: () => void } | null {
  const app = useApp()
  const { store, meta, onFollowHost } = props
  const hostId = store.controller.hostId
  const sessionId = conversationIdOf(store)
  const isSignedIn = useListened(app.account.changes, () => app.account.isSignedIn)
  const hasConnection = useListened(app.cloudSessions.changes, () => app.cloudSessions.connection !== null)
  const hasNewerRows = useListened(app.cloudHistory.changes, () => app.cloudHistory.hasNewerRows(sessionId))
  const isCloudSyncOn = useListened(app.hostSettings.changes, () => {
    const settings = app.hostSettings.stateOf(hostId)
    return settings.kind === 'loaded' ? settings.settings.sessionCloudSync : null
  })
  // A connected host, not this one, that lists the session: the live conversation is there.
  const readLiveHost = () => app.registry.hosts().find((host) => {
    if (host.id === hostId || app.connections.readiness(host.id).readiness !== 'ready') return false
    const shell = app.threads.thread(host.id, sessionId)
    return shell !== null && !shell.cloudOnly
  })?.id ?? null
  useListened(app.connections.changes, readLiveHost)
  const liveServerId = useListened(app.threads.changes, readLiveHost)

  const source = sessionCloudReadSource({
    hasStarted: store.controller.target.record !== undefined,
    hasHostRows: meta.showsHostConversation,
    isSignedIn,
    runServerId: hostId,
    isRunHostAway: props.hostReadiness.away,
    isHostReadUnavailable: (meta.phase.kind === 'error' && meta.phase.noAccess !== true) || meta.hostHasNoCopy,
    // An online run host that answers its history holds the session: the phone
    // reads the cloud only when that host is away or cannot give the rows.
    runTurn: undefined,
    cloud: null,
  })
  const read = cloudReadProgress({ status: meta.cloudRead, source, hasConnection, hasNewerRows })
  const shouldRead = source === 'cloud' && meta.cloudRead.kind === 'idle' && hasConnection
  useEffect(() => {
    if (shouldRead) void store.controller.readCloudHistory()
  }, [shouldRead, store])

  const state: SessionCloudReadView | null = sessionCloudReadView({ source, read, messageCount: store.controller.model.order.length, isTurnLive: false, liveServerId, isCloudSyncOn })
  const stateText = JSON.stringify(state)
  const view = useMemo(() => {
    // SAFETY: stateText is JSON.stringify of SessionCloudReadView | null above.
    const current = JSON.parse(stateText) as SessionCloudReadView | null
    return current ? cloudReadView(current, props.hostLabel, liveServerId, (id) => app.registry.host(id)?.label ?? 'Another host') : null
  }, [app, props.hostLabel, liveServerId, stateText])
  const action = view?.action ?? null
  const onAction = useCallback(() => {
    if (action?.kind === 'open-live') onFollowHost?.(action.hostId)
    else if (action) void store.controller.readCloudHistory()
  }, [action, onFollowHost, store])
  return view ? { view, onAction } : null
}

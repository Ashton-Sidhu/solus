import { sessionCloudReadSource, sessionCloudReadView, type SessionCloudReadView } from '@solus/client-core/session-cloud-read'
import type { HostReadinessState } from '@solus/client-core/host-readiness'
import { useCallback, useEffect, useMemo } from 'react'

import { useApp, useListened } from '../../app/app-context'
import { conversationIdOf, type ConversationMeta, type ConversationStore } from '../conversation/conversation-store'
import { cloudReadView, type CloudReadView } from './lib/cloud-read-view'

/**
 * The session's copy from Solus Cloud on this thread, while no host that holds
 * it is online (docs/plans/portable-sessions-cloud.md, Phase 5B): its state,
 * from what this phone knows now, and its action. The read starts here when
 * the copy applies; a host's history replaces it in the controller. Null when a
 * host shows the conversation.
 */
// The hook joins the host, account, cloud list, and read state for one thread.
// eslint-disable-next-line complexity
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
  const cloudList = useListened(app.cloudSessions.changes, () => app.cloudSessions.listState)
  // Text, so the snapshot compares by value.
  const cloudFacts = useListened(app.cloudSessions.changes, () => {
    const record = app.cloudSessions.recordFor(sessionId)
    return record ? `${record.head ?? ''} ${record.syncedTurn}` : null
  })
  const isCloudSyncOn = useListened(app.hostSettings.changes, () => {
    const settings = app.hostSettings.stateOf(hostId)
    return settings.kind === 'loaded' ? settings.settings.sessionCloudSync : null
  })
  // The copy the conversation shows: the model changes with the order, and an older page with the meta.
  const readCopy = () => {
    const copy = app.cloudHistory.copyOf(store.controller.model)
    return copy ? `${copy.head} ${copy.unavailableTurns}` : null
  }
  useListened(store.order, readCopy)
  const copy = useListened(store.meta, readCopy)
  // A connected host, not this one, that lists the session: the live conversation is there.
  const readLiveHost = () => app.registry.hosts().find((host) => {
    if (host.id === hostId || app.connections.readiness(host.id).readiness !== 'ready') return false
    const shell = app.threads.thread(host.id, sessionId)
    return shell !== null && !shell.cloudOnly
  })?.id ?? null
  useListened(app.connections.changes, readLiveHost)
  const liveServerId = useListened(app.threads.changes, readLiveHost)

  const [head = '', syncedTurn = '0'] = cloudFacts?.split(' ') ?? []
  const [readHead = '', unavailableTurnCount = '0'] = copy?.split(' ') ?? []
  const cloud = cloudFacts === null ? null : { head: head || null, syncedTurn: Number(syncedTurn), lastRunServerId: hostId, lastRunHostId: null, runningHostId: null }
  const source = sessionCloudReadSource({
    hasStarted: store.controller.target.record !== undefined,
    hasHostRows: meta.showsHostConversation,
    isSignedIn,
    isCloudListed: cloudList !== 'loading',
    runServerId: hostId,
    isRunHostAway: props.hostReadiness.away,
    isHostReadUnavailable: (meta.phase.kind === 'error' && meta.phase.noAccess !== true) || meta.hostHasNoCopy,
    isCloudSyncOn,
    runTurn: undefined,
    cloud,
  })
  const read = meta.cloudRead.kind === 'idle' ? null : {
    status: meta.cloudRead.kind,
    error: meta.cloudRead.kind === 'error' ? meta.cloudRead.message : null,
    readHead: readHead || null,
    unavailableTurnCount: Number(unavailableTurnCount),
  }
  const shouldRead = source === 'cloud' && meta.cloudRead.kind === 'idle' && !!cloud?.head
  useEffect(() => {
    if (shouldRead) void store.controller.readCloudHistory()
  }, [shouldRead, store])

  const state: SessionCloudReadView | null = sessionCloudReadView({ source, read, messageCount: store.controller.model.order.length, isTurnLive: false, liveServerId, cloud })
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

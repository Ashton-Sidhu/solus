import { sessionCloudCopyState, shouldReadSessionCloudCopy, type SessionCloudCopyInput, type SessionCloudCopyState } from '@solus/client-core/session-cloud-copy'
import type { HostReadinessState } from '@solus/client-core/host-readiness'
import { useCallback, useEffect, useMemo } from 'react'

import { useApp, useListened } from '../../app/app-context'
import { conversationIdOf, type ConversationMeta, type ConversationStore } from '../conversation/conversation-store'
import { cloudCopyView, type CloudCopyView } from './lib/cloud-copy-view'

/**
 * The session's copy from Solus Cloud on this thread, while no host that holds
 * it is online (docs/plans/portable-sessions-cloud.md, Phase 5B): its state,
 * from what this phone knows now, and its action. The read starts here when
 * the copy applies; a host's history replaces it in the controller. Null when a
 * host shows the conversation.
 */
export function useCloudCopy(props: {
  readonly store: ConversationStore
  readonly meta: ConversationMeta
  readonly hostReadiness: HostReadinessState
  readonly hostLabel: string
  readonly onFollowHost?: (hostId: string) => ConversationStore | null
}): { view: CloudCopyView; onAction: () => void } | null {
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

  const input = useMemo<SessionCloudCopyInput>(() => {
    const [head = '', syncedTurn = '0'] = cloudFacts?.split(' ') ?? []
    const [readHead = '', unavailableTurns = '0'] = copy?.split(' ') ?? []
    return {
      hasStarted: store.controller.target.record !== undefined,
      showsHostConversation: meta.showsHostConversation,
      isRunHostAway: props.hostReadiness.away,
      hasLoadFailed: meta.phase.kind === 'error' && meta.phase.noAccess !== true,
      awaitsHostCopy: meta.hostHasNoCopy,
      isSignedIn,
      cloudList,
      cloud: cloudFacts === null ? null : { head: head || null, syncedTurn: Number(syncedTurn) },
      isCloudSyncOn,
      read: meta.cloudRead,
      readHead: readHead || null,
      unavailableTurns: Number(unavailableTurns),
      liveServerId,
    }
  }, [cloudFacts, cloudList, copy, isCloudSyncOn, isSignedIn, liveServerId, meta.cloudRead, meta.hostHasNoCopy, meta.phase, meta.showsHostConversation, props.hostReadiness.away, store])

  const shouldRead = shouldReadSessionCloudCopy(input)
  useEffect(() => {
    if (shouldRead) void store.controller.readCloudCopy()
  }, [shouldRead, store])

  // Text, so the view keeps its object while the state is the same.
  const stateText = JSON.stringify(sessionCloudCopyState(input))
  const view = useMemo(() => {
    // SAFETY: the text is `JSON.stringify` of a `sessionCloudCopyState` answer, made above.
    const state = JSON.parse(stateText) as SessionCloudCopyState | null
    return state ? cloudCopyView(state, props.hostLabel, (id) => app.registry.host(id)?.label ?? 'Another host') : null
  }, [app, props.hostLabel, stateText])
  const action = view?.action ?? null
  const onAction = useCallback(() => {
    if (action?.kind === 'open-live') onFollowHost?.(action.hostId)
    else if (action) void store.controller.readCloudCopy()
  }, [action, onFollowHost, store])
  return view ? { view, onAction } : null
}

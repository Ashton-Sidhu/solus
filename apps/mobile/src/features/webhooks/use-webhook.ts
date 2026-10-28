import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import type { HostApi } from '@solus/client-core/host-api'
import type { Webhook, WebhookDelivery, WebhookDeliverySummary } from '@solus/contracts/webhooks'
import { useApp, useListened } from '../../app/app-context'
import { tryCopyTextWithHaptic } from '../../lib/copyTextWithHaptic'
import { errorMessage } from '../settings/integrations'
import { appendDeliveries, copyTarget, sortDeliveries, withDelivery, type CopyTarget } from './webhooks'

const DELIVERY_PAGE_SIZE = 50

export type WebhookState =
  | { kind: 'loading' }
  | { kind: 'loaded'; webhook: Webhook }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }

export type DeliveryListState =
  | { kind: 'loading' }
  | { kind: 'loaded'; deliveries: WebhookDeliverySummary[]; hasMore: boolean; loadingMore: boolean }
  | { kind: 'error'; message: string }

export type WebhookChange = 'pause' | 'copy'

/**
 * One webhook and its deliveries, newest first (docs/plans/webhooks.md §3.3).
 * Read on connect and on focus. `webhook.changed` keeps the record current,
 * and `webhook.delivery` puts each new or finished delivery in place. Pause,
 * Resume, and Copy run one at a time; a refused change throws, and the screen
 * says why.
 */
export function useWebhook(hostId: string, webhookId: string) {
  const app = useApp()
  const readiness = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness)
  const connected = readiness === 'ready'
  const [webhook, setWebhook] = useState<WebhookState>({ kind: 'loading' })
  const [deliveries, setDeliveries] = useState<DeliveryListState>({ kind: 'loading' })
  const [busy, setBusy] = useState<WebhookChange | null>(null)
  /** The same change as `busy`, read at once, so a second tap waits for the first. */
  const busyRef = useRef<WebhookChange | null>(null)
  const webhookRequest = useRef(0)
  const deliveriesRequest = useRef(0)

  const connection = useCallback(() => app.connections.connection(hostId), [app, hostId])

  const reload = useCallback(() => {
    const current = connection()
    if (!current) return
    const read = ++webhookRequest.current
    setWebhook((state) => (state.kind === 'loaded' ? state : { kind: 'loading' }))
    current.api.webhookRead(webhookId).then(
      (found) => {
        if (read !== webhookRequest.current || connection() !== current) return
        setWebhook(found ? { kind: 'loaded', webhook: found } : { kind: 'missing' })
      },
      (cause: unknown) => {
        if (read !== webhookRequest.current || connection() !== current) return
        setWebhook({ kind: 'error', message: errorMessage(cause) })
      },
    )
    const page = ++deliveriesRequest.current
    setDeliveries((state) => (state.kind === 'loaded' ? state : { kind: 'loading' }))
    current.api.webhookListDeliveries(webhookId, { limit: DELIVERY_PAGE_SIZE }).then(
      (summaries) => {
        if (page !== deliveriesRequest.current || connection() !== current) return
        setDeliveries({ kind: 'loaded', deliveries: sortDeliveries(summaries), hasMore: summaries.length === DELIVERY_PAGE_SIZE, loadingMore: false })
      },
      (cause: unknown) => {
        if (page !== deliveriesRequest.current || connection() !== current) return
        setDeliveries({ kind: 'error', message: errorMessage(cause) })
      },
    )
  }, [connection, webhookId])

  useEffect(() => {
    if (connected) reload()
  }, [connected, reload])

  useFocusEffect(reload)

  useEffect(() => {
    const current = connected ? connection() : null
    if (!current) return
    const stopChanged = current.events.subscribe('webhook.changed', (event) => {
      if (event.kind === 'saved' ? event.webhook.id !== webhookId : event.webhookId !== webhookId) return
      webhookRequest.current++
      setWebhook(event.kind === 'saved' ? { kind: 'loaded', webhook: event.webhook } : { kind: 'missing' })
    })
    const stopDelivery = current.events.subscribe('webhook.delivery', (delivery) => {
      if (delivery.webhookId !== webhookId) return
      setDeliveries((state) => (state.kind === 'loaded' ? { ...state, deliveries: withDelivery(state.deliveries, delivery) } : state))
    })
    return () => {
      stopChanged()
      stopDelivery()
    }
  }, [connected, connection, webhookId])

  /** Adds the next older page below the deliveries shown. */
  const loadMore = () => {
    const current = connection()
    const state = deliveries
    if (!current || state.kind !== 'loaded' || !state.hasMore || state.loadingMore) return
    const oldest = state.deliveries[state.deliveries.length - 1]
    if (!oldest) return
    const page = deliveriesRequest.current
    setDeliveries({ ...state, loadingMore: true })
    current.api.webhookListDeliveries(webhookId, { limit: DELIVERY_PAGE_SIZE, before: oldest.arrivedAt }).then(
      (summaries) => {
        if (page !== deliveriesRequest.current) return
        setDeliveries((latest) => latest.kind === 'loaded'
          ? { kind: 'loaded', deliveries: appendDeliveries(latest.deliveries, summaries), hasMore: summaries.length === DELIVERY_PAGE_SIZE, loadingMore: false }
          : latest)
      },
      // The deliveries stay; Show more asks again.
      () => { if (page === deliveriesRequest.current) setDeliveries((latest) => (latest.kind === 'loaded' ? { ...latest, loadingMore: false } : latest)) },
    )
  }

  /** Runs one change at a time. */
  const change = async <T,>(name: WebhookChange, run: (api: HostApi) => Promise<T>): Promise<T> => {
    const current = connection()
    if (!current || !connected) throw new Error('This host cannot be reached now.')
    if (busyRef.current) throw new Error('Another change is in progress.')
    busyRef.current = name
    setBusy(name)
    // The React Compiler cannot compile try/finally. The async wrapper turns a
    // synchronous throw into a rejection, so finally sees both.
    return await (async () => run(current.api))().finally(() => {
      busyRef.current = null
      setBusy(null)
    })
  }

  const keep = (updated: Webhook | null) => {
    webhookRequest.current++
    setWebhook(updated ? { kind: 'loaded', webhook: updated } : { kind: 'missing' })
  }

  /** Pause is the owner's `enabled: false` (plan §5). An admin pause has no Resume here. */
  const setEnabled = async (enabled: boolean): Promise<void> => {
    keep(await change('pause', (api) => api.webhookUpdate(webhookId, { enabled })))
  }

  /**
   * Reads the URL again (only the owner gets it), puts it on the clipboard,
   * and tells the host it was copied, so the "URL changed" mark goes away.
   * Returns what could be copied; the screen says why when nothing was.
   */
  const copyUrl = async (): Promise<CopyTarget> => change('copy', async (api) => {
    const target = copyTarget(await api.webhookRead(webhookId))
    if (target.kind !== 'url') return target
    if (!(await tryCopyTextWithHaptic(target.url, { target: 'webhook URL' }))) throw new Error('The clipboard refused the URL. Try again.')
    keep(await api.webhookUpdate(webhookId, { copiedUrl: target.url }))
    return target
  })

  return { webhook, deliveries, connected, busy, reload, loadMore, setEnabled, copyUrl }
}

export type DeliveryState =
  | { kind: 'loading' }
  | { kind: 'loaded'; delivery: WebhookDelivery }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }

/**
 * One delivery with its request and one result for each action. Read on
 * connect and on focus, and again when `webhook.delivery` names it (its
 * actions finished). Replay runs the stored request again, for all actions or
 * for one; the host refuses a paused webhook.
 */
export function useWebhookDelivery(hostId: string, webhookId: string, deliveryId: string) {
  const app = useApp()
  const readiness = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness)
  const connected = readiness === 'ready'
  const [state, setState] = useState<DeliveryState>({ kind: 'loading' })
  const [replaying, setReplaying] = useState(false)
  const replayingRef = useRef(false)
  const request = useRef(0)

  const connection = useCallback(() => app.connections.connection(hostId), [app, hostId])

  const reload = useCallback(() => {
    const current = connection()
    if (!current) return
    const read = ++request.current
    setState((previous) => (previous.kind === 'loaded' ? previous : { kind: 'loading' }))
    current.api.webhookReadDelivery(webhookId, deliveryId).then(
      (delivery) => {
        if (read !== request.current || connection() !== current) return
        setState(delivery ? { kind: 'loaded', delivery } : { kind: 'missing' })
      },
      (cause: unknown) => {
        if (read !== request.current || connection() !== current) return
        setState({ kind: 'error', message: errorMessage(cause) })
      },
    )
  }, [connection, webhookId, deliveryId])

  useEffect(() => {
    if (connected) reload()
  }, [connected, reload])

  useFocusEffect(reload)

  useEffect(() => {
    const current = connected ? connection() : null
    if (!current) return
    return current.events.subscribe('webhook.delivery', (delivery) => {
      if (delivery.id === deliveryId) reload()
    })
  }, [connected, connection, deliveryId, reload])

  /** Returns the summary of the new delivery that the replay made. */
  const replay = async (actionId?: string): Promise<WebhookDeliverySummary> => {
    const current = connection()
    if (!current || !connected) throw new Error('This host cannot be reached now.')
    if (replayingRef.current) throw new Error('A replay is in progress.')
    replayingRef.current = true
    setReplaying(true)
    return await (async () => current.api.webhookReplay(webhookId, deliveryId, actionId))().finally(() => {
      replayingRef.current = false
      setReplaying(false)
    })
  }

  return { state, connected, replaying, reload, replay }
}

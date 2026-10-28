import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import type { HostWebhookSettingsPatch } from '@solus/contracts/webhooks'
import { useApp, useListened } from '../../app/app-context'
import { errorMessage, isUnsupportedMethodError } from '../settings/integrations'
import { sortWebhooks, withoutWebhook, withWebhook, type HostWebhookSettingsState, type WebhookListState } from './webhooks'

/**
 * The host's webhook settings (docs/plans/webhooks.md §2.3, §4): the public
 * URL and, for a linked host, the hold switch. Read on connect and on focus;
 * no event announces a change, so a change here keeps the host's answer. Only
 * a host administrator may change them (`host.admin`).
 */
export function useHostWebhookSettings(hostId: string) {
  const app = useApp()
  const readiness = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness)
  const connected = readiness === 'ready'
  const isAdmin = useListened(app.connections.changes, () => app.connections.may(hostId, 'host.admin'))
  /** A personal host sleeps with its computer; the reachability text says so (plan §4). */
  const isPersonalHost = useListened(app.registry.changes, () => app.registry.host(hostId)?.uplink?.category === 'personal')
  const [state, setState] = useState<HostWebhookSettingsState>({ kind: 'loading' })
  /** Bumped by every read and change; an older answer does not land. */
  const request = useRef(0)

  const reload = useCallback(() => {
    const current = app.connections.connection(hostId)
    if (!current) return
    const read = ++request.current
    setState((previous) => (previous.kind === 'loaded' ? previous : { kind: 'loading' }))
    current.api.hostWebhookSettingsRead().then(
      (settings) => { if (read === request.current) setState({ kind: 'loaded', settings }) },
      (cause: unknown) => {
        if (read !== request.current) return
        const message = errorMessage(cause)
        setState(isUnsupportedMethodError(message) ? { kind: 'unsupported' } : { kind: 'error', message })
      },
    )
  }, [app, hostId])

  useEffect(() => {
    if (connected) reload()
  }, [connected, reload])

  useFocusEffect(reload)

  /** Keeps the host's answer; a refused change throws, and the screen says why. */
  const update = async (patch: HostWebhookSettingsPatch): Promise<void> => {
    const current = app.connections.connection(hostId)
    if (!current || !connected) throw new Error('This host cannot be reached now.')
    const change = ++request.current
    const settings = await current.api.hostWebhookSettingsUpdate(patch)
    if (change === request.current) setState({ kind: 'loaded', settings })
  }

  return { state, isAdmin, isPersonalHost, reload, update }
}

/**
 * The webhooks of one host for its Webhooks screen. Read on connect, on
 * focus, and on reconnect. `webhook.changed` puts the saved record in place;
 * `webhook.delivery` reads the list again, because the last delivery and the
 * 24-hour count are the host's to count. A reply that arrives after a newer
 * request, or from a connection that has gone, is dropped.
 */
export function useWebhooks(hostId: string) {
  const app = useApp()
  const readiness = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness)
  const connected = readiness === 'ready'
  const [list, setList] = useState<WebhookListState>({ kind: 'loading' })
  const request = useRef(0)

  const connection = useCallback(() => app.connections.connection(hostId), [app, hostId])

  const reload = useCallback(() => {
    const current = connection()
    if (!current) return
    const read = ++request.current
    setList((state) => (state.kind === 'loaded' ? state : { kind: 'loading' }))
    current.api.webhookList().then(
      (webhooks) => {
        if (read !== request.current || connection() !== current) return
        setList({ kind: 'loaded', webhooks: sortWebhooks(webhooks) })
      },
      (cause: unknown) => {
        if (read !== request.current || connection() !== current) return
        const message = errorMessage(cause)
        setList(isUnsupportedMethodError(message) ? { kind: 'unsupported' } : { kind: 'error', message })
      },
    )
  }, [connection])

  useEffect(() => {
    if (connected) reload()
  }, [connected, reload])

  useFocusEffect(reload)

  useEffect(() => {
    const current = connected ? connection() : null
    if (!current) return
    const stopChanged = current.events.subscribe('webhook.changed', (event) => {
      // A read in flight may be older than this change; the event wins.
      request.current++
      setList((state) => {
        if (state.kind !== 'loaded') return state
        return {
          kind: 'loaded',
          webhooks: event.kind === 'saved' ? withWebhook(state.webhooks, event.webhook) : withoutWebhook(state.webhooks, event.webhookId),
        }
      })
    })
    const stopDelivery = current.events.subscribe('webhook.delivery', () => reload())
    return () => {
      stopChanged()
      stopDelivery()
    }
  }, [connected, connection, reload])

  return { list, connected, reload }
}

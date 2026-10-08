import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import type { HostApi } from '@solus/client-core/host-api'
import type { Integration } from '@solus/contracts/integration-types'
import { useApp, useListened } from '../../app/app-context'
import {
  errorMessage,
  isUnsupportedMethodError,
  sortIntegrations,
  upsertIntegration,
  withoutIntegration,
  type CatalogState,
  type IntegrationAction,
  type IntegrationCandidate,
  type IntegrationListState,
  type IntegrationToolsState,
  type ProbeState,
} from './integrations'

const CATALOG_DELAY_MS = 250
const CATALOG_LIMIT = 30

/**
 * The integrations of one host for its Integrations screen. Read on connect,
 * on focus, and on reconnect; `integration.changed` reads the list again and,
 * on `tools`, the tools of an open integration. A reply that arrives after a
 * newer request, or from a connection that has gone, is dropped. A change the
 * host refused throws; the screen says why.
 */
export function useIntegrations(hostId: string) {
  const app = useApp()
  const phase = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase)
  const connected = phase === 'connected'
  const [list, setList] = useState<IntegrationListState>({ kind: 'loading' })
  const [tools, setTools] = useState<ReadonlyMap<string, IntegrationToolsState>>(new Map())
  const [catalog, setCatalog] = useState<CatalogState>({ kind: 'idle' })
  const [probeState, setProbe] = useState<ProbeState>({ kind: 'idle' })
  const [busy, setBusy] = useState<IntegrationAction | null>(null)
  /** The same change as `busy`, read at once, so a second tap waits for the first. */
  const busyRef = useRef<IntegrationAction | null>(null)

  const listRequest = useRef(0)
  const toolsRequests = useRef(new Map<string, number>())
  const catalogRequest = useRef(0)
  const catalogTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const probeRequest = useRef(0)
  /** The integrations whose tools are open; read by the event handler. */
  const openIds = useRef(new Set<string>())

  const connection = useCallback(() => app.connections.connection(hostId), [app, hostId])

  const reload = useCallback(() => {
    const current = connection()
    if (!current) return
    const request = ++listRequest.current
    setList((state) => (state.kind === 'loaded' ? state : { kind: 'loading' }))
    current.api.integrationList().then(
      (integrations) => {
        if (request !== listRequest.current || connection() !== current) return
        setList({ kind: 'loaded', integrations: sortIntegrations([...integrations]) })
      },
      (cause: unknown) => {
        if (request !== listRequest.current || connection() !== current) return
        const message = errorMessage(cause)
        setList(isUnsupportedMethodError(message) ? { kind: 'unsupported' } : { kind: 'error', message })
      },
    )
  }, [connection])

  const loadTools = useCallback((integrationId: string) => {
    const current = connection()
    if (!current) return
    openIds.current.add(integrationId)
    const request = (toolsRequests.current.get(integrationId) ?? 0) + 1
    toolsRequests.current.set(integrationId, request)
    const put = (state: IntegrationToolsState) => {
      if (toolsRequests.current.get(integrationId) !== request || !openIds.current.has(integrationId)) return
      setTools((previous) => new Map(previous).set(integrationId, state))
    }
    setTools((previous) => (previous.get(integrationId)?.kind === 'loaded' ? previous : new Map(previous).set(integrationId, { kind: 'loading' })))
    current.api.integrationTools({ id: integrationId }).then(
      (summaries) => put({ kind: 'loaded', tools: summaries }),
      (cause: unknown) => put({ kind: 'error', message: errorMessage(cause) }),
    )
  }, [connection])

  const closeTools = useCallback((integrationId: string) => {
    openIds.current.delete(integrationId)
    setTools((previous) => {
      const next = new Map(previous)
      next.delete(integrationId)
      return next
    })
  }, [])

  // Connect and reconnect: the list, and the tools of every open integration.
  useEffect(() => {
    if (!connected) return
    reload()
    for (const integrationId of openIds.current) loadTools(integrationId)
  }, [connected, reload, loadTools])

  useFocusEffect(reload)

  useEffect(() => {
    const current = connected ? connection() : null
    if (!current) return
    return current.events.subscribe('integration.changed', ({ integrationId, change }) => {
      if (change === 'removed') closeTools(integrationId)
      if (change === 'tools') {
        if (openIds.current.has(integrationId)) loadTools(integrationId)
        return
      }
      reload()
    })
  }, [connected, connection, reload, loadTools, closeTools])

  useEffect(() => () => {
    if (catalogTimer.current) clearTimeout(catalogTimer.current)
  }, [])

  /** Searches the catalog after a short pause in typing; an empty query lists the most popular entries. */
  const searchCatalog = useCallback((query: string) => {
    if (catalogTimer.current) clearTimeout(catalogTimer.current)
    const request = ++catalogRequest.current
    const trimmed = query.trim()
    setCatalog({ kind: 'loading', query: trimmed })
    catalogTimer.current = setTimeout(() => {
      const current = connection()
      if (!current) {
        setCatalog({ kind: 'error', query: trimmed, message: 'This host cannot be reached now.' })
        return
      }
      current.api.integrationCatalogList({ query: trimmed || undefined, limit: CATALOG_LIMIT }).then(
        (entries) => { if (request === catalogRequest.current) setCatalog({ kind: 'loaded', query: trimmed, entries }) },
        (cause: unknown) => { if (request === catalogRequest.current) setCatalog({ kind: 'error', query: trimmed, message: errorMessage(cause) }) },
      )
    }, CATALOG_DELAY_MS)
  }, [connection])

  const clearCatalog = useCallback(() => {
    if (catalogTimer.current) clearTimeout(catalogTimer.current)
    catalogRequest.current++
    setCatalog({ kind: 'idle' })
  }, [])

  /** Checks a server anonymously. Only the newest check is kept. */
  const probe = useCallback((url: string) => {
    const current = connection()
    const request = ++probeRequest.current
    if (!current) {
      setProbe({ kind: 'error', url, message: 'This host cannot be reached now.' })
      return
    }
    setProbe({ kind: 'probing', url })
    current.api.integrationProbe({ url }).then(
      (result) => { if (request === probeRequest.current) setProbe({ kind: 'done', url, result }) },
      (cause: unknown) => { if (request === probeRequest.current) setProbe({ kind: 'error', url, message: errorMessage(cause) }) },
    )
  }, [connection])

  const clearProbe = useCallback(() => {
    probeRequest.current++
    setProbe({ kind: 'idle' })
  }, [])

  /** Runs one change at a time and keeps the host's answer in the list. */
  const change = async <T,>(action: IntegrationAction, run: (api: HostApi) => Promise<T>): Promise<T> => {
    const current = connection()
    if (!current || !connected) throw new Error('This host cannot be reached now.')
    if (busyRef.current) throw new Error('Another change is in progress.')
    busyRef.current = action
    setBusy(action)
    try {
      return await run(current.api)
    } finally {
      busyRef.current = null
      setBusy(null)
    }
  }

  const applyToList = (update: (integrations: Integration[]) => Integration[]) => {
    setList((state) => (state.kind === 'loaded' ? { kind: 'loaded', integrations: update(state.integrations) } : state))
  }

  const create = async (candidate: IntegrationCandidate): Promise<Integration> => {
    const integration = await change('create', (api) => api.integrationCreate(candidate))
    applyToList((integrations) => upsertIntegration(integrations, integration))
    return integration
  }

  const rename = async (integrationId: string, name: string): Promise<void> => {
    const integration = await change(`rename:${integrationId}`, (api) => api.integrationUpdate({ id: integrationId, name }))
    applyToList((integrations) => upsertIntegration(integrations, integration))
  }

  const remove = async (integrationId: string): Promise<void> => {
    await change(`remove:${integrationId}`, (api) => api.integrationRemove({ id: integrationId }))
    closeTools(integrationId)
    applyToList((integrations) => withoutIntegration(integrations, integrationId))
  }

  return {
    connected,
    list,
    tools,
    catalog,
    probeState,
    busy,
    reload,
    loadTools,
    closeTools,
    searchCatalog,
    clearCatalog,
    probe,
    clearProbe,
    create,
    rename,
    remove,
  }
}

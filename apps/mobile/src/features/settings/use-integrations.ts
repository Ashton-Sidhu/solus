import { useCallback, useEffect, useRef, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import type { HostApi } from '@solus/client-core/host-api'
import type { Integration, IntegrationConnection, IntegrationOAuthClientInput } from '@solus/contracts/integration-types'
import { useApp, useListened } from '../../app/app-context'
import {
  appendCatalogEntries,
  CATALOG_PAGE_SIZE,
  connectFailed,
  connectFinished,
  connectionMap,
  connectRefused,
  connectReset,
  connectStarted,
  connectSubmitted,
  connectSubmitting,
  errorMessage,
  isUnsupportedMethodError,
  mayLoadTools,
  probeRefusal,
  sortIntegrations,
  upsertIntegration,
  withConnection,
  withoutIntegration,
  type AddState,
  type CatalogState,
  type ConnectFlowState,
  type ConnectionListState,
  type IntegrationAction,
  type IntegrationCandidate,
  type IntegrationListState,
  type IntegrationToolsState,
} from './integrations'

const CATALOG_DELAY_MS = 250

/**
 * The MCP servers of one host for its MCP screen. Read on connect, on focus,
 * and on reconnect; `integration.changed` reads the list again and, on
 * `tools`, the tools of an open server. A reply that arrives after a newer
 * request, or from a connection that has gone, is dropped. A change the host
 * refused throws; the screen says why. The person's own connections are read
 * beside the list and follow `integration.connectionChanged`; the connect
 * flows are `useIntegrationConnect`'s. Tools are read only for an open row
 * whose server can answer (`mayLoadTools`), so a server that is not connected
 * never shows an error for them.
 */
export function useIntegrations(hostId: string) {
  const app = useApp()
  const phase = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase)
  const connected = phase === 'connected'
  const [list, setList] = useState<IntegrationListState>({ kind: 'loading' })
  const [connections, setConnections] = useState<ConnectionListState>({ kind: 'loading' })
  const flows = useIntegrationConnect(hostId)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [tools, setTools] = useState<ReadonlyMap<string, IntegrationToolsState>>(new Map())
  const [catalog, setCatalog] = useState<CatalogState>({ kind: 'idle' })
  const [adding, setAdding] = useState<AddState | null>(null)
  const [busy, setBusy] = useState<IntegrationAction | null>(null)
  /** The same change as `busy`, read at once, so a second tap waits for the first. */
  const busyRef = useRef<IntegrationAction | null>(null)
  /** The same add as `adding`, read at once, so a second Add waits for the first. */
  const addingRef = useRef(false)

  const listRequest = useRef(0)
  const connectionsRequest = useRef(0)
  const toolsRequests = useRef(new Map<string, number>())
  const catalogRequest = useRef(0)
  const catalogTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** The open rows, the list, and the connections, read by the event handlers. */
  const openIds = useRef(new Set<string>())
  const listRef = useRef(list)
  listRef.current = list
  const connectionsRef = useRef(connections)
  connectionsRef.current = connections

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
    const connectionsAt = ++connectionsRequest.current
    current.api.integrationConnectionList().then(
      (own) => {
        if (connectionsAt !== connectionsRequest.current || connection() !== current) return
        setConnections({ kind: 'loaded', byIntegration: connectionMap(own) })
      },
      (cause: unknown) => {
        if (connectionsAt !== connectionsRequest.current || connection() !== current) return
        const message = errorMessage(cause)
        setConnections(isUnsupportedMethodError(message) ? { kind: 'unsupported' } : { kind: 'error', message })
      },
    )
  }, [connection])

  const dropTools = useCallback((integrationId: string) => {
    toolsRequests.current.set(integrationId, (toolsRequests.current.get(integrationId) ?? 0) + 1)
    setTools((previous) => {
      if (!previous.has(integrationId)) return previous
      const next = new Map(previous)
      next.delete(integrationId)
      return next
    })
  }, [])

  /** Reads the tools of an open row, only when its server can answer. */
  const loadTools = useCallback((integrationId: string) => {
    const current = connection()
    const state = listRef.current
    const integration = state.kind === 'loaded' ? state.integrations.find((entry) => entry.id === integrationId) : undefined
    if (!current || !openIds.current.has(integrationId) || !integration || !mayLoadTools(integration, connectionsRef.current)) return
    const request = (toolsRequests.current.get(integrationId) ?? 0) + 1
    toolsRequests.current.set(integrationId, request)
    const put = (next: IntegrationToolsState) => {
      if (toolsRequests.current.get(integrationId) !== request || !openIds.current.has(integrationId)) return
      setTools((previous) => new Map(previous).set(integrationId, next))
    }
    setTools((previous) => (previous.get(integrationId)?.kind === 'loaded' ? previous : new Map(previous).set(integrationId, { kind: 'loading' })))
    current.api.integrationTools({ id: integrationId }).then(
      (summaries) => put({ kind: 'loaded', tools: summaries }),
      (cause: unknown) => put({ kind: 'error', message: errorMessage(cause) }),
    )
  }, [connection])

  const expand = useCallback((integrationId: string) => {
    openIds.current.add(integrationId)
    setExpanded(new Set(openIds.current))
  }, [])

  const collapse = useCallback((integrationId: string) => {
    openIds.current.delete(integrationId)
    setExpanded(new Set(openIds.current))
    dropTools(integrationId)
  }, [dropTools])

  const toggle = useCallback((integrationId: string) => {
    if (openIds.current.has(integrationId)) collapse(integrationId)
    else expand(integrationId)
  }, [collapse, expand])

  // An open row reads its tools once its server can answer (a sign-in just
  // finished, the list or the connections arrived), and lets them go when it
  // no longer can (a disconnect).
  useEffect(() => {
    if (!connected || list.kind !== 'loaded') return
    for (const integration of list.integrations) {
      if (!expanded.has(integration.id)) continue
      const allowed = mayLoadTools(integration, connections)
      if (allowed && !tools.has(integration.id)) loadTools(integration.id)
      if (!allowed && tools.has(integration.id)) dropTools(integration.id)
    }
  }, [connected, list, connections, expanded, tools, loadTools, dropTools])

  // Connect and reconnect: the list, and the tools of every open row.
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
      if (change === 'removed') collapse(integrationId)
      if (change === 'tools') {
        loadTools(integrationId)
        return
      }
      reload()
    })
  }, [connected, connection, reload, loadTools, collapse])

  useEffect(() => {
    const current = connected ? connection() : null
    if (!current) return
    return current.events.subscribe('integration.connectionChanged', ({ integrationId, connection: changed }) => {
      // A read in flight may be older than this change; the event wins.
      connectionsRequest.current++
      setConnections((state) => ({
        kind: 'loaded',
        byIntegration: withConnection(state.kind === 'loaded' ? state.byIntegration : new Map<string, IntegrationConnection>(), integrationId, changed),
      }))
    })
  }, [connected, connection])

  useEffect(() => () => {
    if (catalogTimer.current) clearTimeout(catalogTimer.current)
  }, [])

  /** Reads the first page of a search; an empty query lists the most popular entries. */
  const readCatalog = useCallback((query: string, delay: number) => {
    if (catalogTimer.current) clearTimeout(catalogTimer.current)
    const request = ++catalogRequest.current
    const trimmed = query.trim()
    // The last answer stays on screen while a new search runs, so the list does not collapse.
    setCatalog((state) => (state.kind === 'loaded' ? { ...state, loadingMore: false, searching: true } : { kind: 'loading', query: trimmed }))
    catalogTimer.current = setTimeout(() => {
      const current = connection()
      if (!current) {
        setCatalog({ kind: 'error', query: trimmed, message: 'This host cannot be reached now.' })
        return
      }
      current.api.integrationCatalogList({ query: trimmed || undefined, offset: 0, limit: CATALOG_PAGE_SIZE }).then(
        (page) => { if (request === catalogRequest.current) setCatalog({ kind: 'loaded', query: trimmed, entries: page.entries, total: page.total, loadingMore: false, searching: false }) },
        (cause: unknown) => { if (request === catalogRequest.current) setCatalog({ kind: 'error', query: trimmed, message: errorMessage(cause) }) },
      )
    }, delay)
  }, [connection])

  /** Searches the catalog after a short pause in typing. */
  const searchCatalog = useCallback((query: string) => readCatalog(query, CATALOG_DELAY_MS), [readCatalog])

  /** Reads the same search again at once, after an error. */
  const retryCatalog = useCallback((query: string) => readCatalog(query, 0), [readCatalog])

  /** Adds the next page below the entries shown, so nothing above them moves. */
  const loadMoreCatalog = useCallback(() => {
    const state = catalog
    const current = connection()
    if (!current || state.kind !== 'loaded' || state.loadingMore || state.searching || state.entries.length >= state.total) return
    const request = catalogRequest.current
    setCatalog({ ...state, loadingMore: true })
    current.api.integrationCatalogList({ query: state.query || undefined, offset: state.entries.length, limit: CATALOG_PAGE_SIZE }).then(
      (page) => {
        if (request !== catalogRequest.current) return
        setCatalog((latest) => latest.kind === 'loaded'
          ? { ...latest, entries: appendCatalogEntries(latest.entries, page.entries), total: page.total, loadingMore: false }
          : latest)
      },
      // The entries stay; Show more asks again.
      () => { if (request === catalogRequest.current) setCatalog((latest) => latest.kind === 'loaded' ? { ...latest, loadingMore: false } : latest) },
    )
  }, [catalog, connection])

  const clearCatalog = useCallback(() => {
    if (catalogTimer.current) clearTimeout(catalogTimer.current)
    catalogRequest.current++
    setCatalog({ kind: 'idle' })
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

  /**
   * One-step add: the host checks the server, then creates it. A server the
   * probe cannot place, or a refused create, leaves nothing behind; the entry
   * says why. Returns the created server, or null.
   */
  const add = async (candidate: IntegrationCandidate): Promise<Integration | null> => {
    if (addingRef.current) return null
    addingRef.current = true
    const { url } = candidate
    setAdding({ url, step: 'checking' })
    try {
      const current = connection()
      if (!current || !connected) throw new Error('This host cannot be reached now.')
      const refusal = probeRefusal(await current.api.integrationProbe({ url }))
      if (refusal) {
        setAdding({ url, step: 'failed', message: refusal })
        return null
      }
      const integration = await change('create', (api) => api.integrationCreate(candidate))
      applyToList((integrations) => upsertIntegration(integrations, integration))
      setAdding(null)
      return integration
    } catch (cause) {
      setAdding({ url, step: 'failed', message: errorMessage(cause) })
      return null
    } finally {
      addingRef.current = false
    }
  }

  const clearAdding = useCallback(() => setAdding(null), [])

  const rename = async (integrationId: string, name: string): Promise<void> => {
    const integration = await change(`rename:${integrationId}`, (api) => api.integrationUpdate({ id: integrationId, name }))
    applyToList((integrations) => upsertIntegration(integrations, integration))
  }

  const remove = async (integrationId: string): Promise<void> => {
    await change(`remove:${integrationId}`, (api) => api.integrationRemove({ id: integrationId }))
    collapse(integrationId)
    applyToList((integrations) => withoutIntegration(integrations, integrationId))
  }

  /** Removes the person's own token and connection; the row follows `integration.connectionChanged`. */
  const disconnect = async (integrationId: string): Promise<void> => {
    await change(`disconnect:${integrationId}`, (api) => api.integrationDisconnect({ id: integrationId }))
    setConnections((state) => (state.kind === 'loaded' ? { kind: 'loaded', byIntegration: withConnection(state.byIntegration, integrationId, null) } : state))
  }

  /**
   * Saves the administrator's OAuth client, or removes it with null. The
   * secret goes to the host once; only the host's record, which says whether
   * a secret is saved, lands in the list.
   */
  const setOAuthClient = async (integrationId: string, oauthClient: IntegrationOAuthClientInput | null): Promise<void> => {
    const integration = await change(`oauth-client:${integrationId}`, (api) => api.integrationUpdate({ id: integrationId, oauthClient }))
    applyToList((integrations) => upsertIntegration(integrations, integration))
  }

  return {
    connected,
    list,
    connections,
    flows,
    expanded,
    tools,
    catalog,
    adding,
    busy,
    reload,
    expand,
    toggle,
    searchCatalog,
    retryCatalog,
    loadMoreCatalog,
    clearCatalog,
    add,
    clearAdding,
    rename,
    remove,
    disconnect,
    setOAuthClient,
  }
}

/**
 * The person's sign-in to integrations of one host (§4.3), one flow per
 * integration. The Integrations rows and the conversation's connect sheet run
 * the same flow. Connect asks the host; a `waiting` flow opens its page in the
 * system browser only when the person taps Open sign-in, takes the address the
 * browser ended on, and ends on `host.integrationAuthFinished`; a `token` flow
 * takes an API key. A flow still waiting is cancelled on the host when the
 * surface closes, and a reset finishes it, since its end may have been missed.
 */
export function useIntegrationConnect(hostId: string) {
  const app = useApp()
  const phase = useListened(app.connections.changes, () => app.connections.state(hostId)?.phase)
  const connected = phase === 'connected'
  const [flows, setFlows] = useState<ReadonlyMap<string, ConnectFlowState>>(new Map())
  /** The same flows, read at once by the event handlers and the commands. */
  const flowsRef = useRef(new Map<string, ConnectFlowState>())
  /** The name each flow speaks of, kept from Connect. */
  const names = useRef(new Map<string, string>())
  /** Bumps on each Connect and close; an answer for an older one is dropped. */
  const attempts = useRef(new Map<string, number>())

  const connection = useCallback(() => app.connections.connection(hostId), [app, hostId])

  const put = useCallback((integrationId: string, next: ConnectFlowState | null) => {
    if (next) flowsRef.current.set(integrationId, next)
    else flowsRef.current.delete(integrationId)
    setFlows(new Map(flowsRef.current))
  }, [])

  const update = useCallback((integrationId: string, change: (state: ConnectFlowState) => ConnectFlowState | null) => {
    const state = flowsRef.current.get(integrationId)
    if (state) put(integrationId, change(state))
  }, [put])

  useEffect(() => {
    const current = connected ? connection() : null
    if (!current) return
    const stopFinished = current.events.subscribe('host.integrationAuthFinished', (event) => {
      update(event.integrationId, (state) => connectFinished(state, event, names.current.get(event.integrationId) ?? 'the integration'))
    })
    const stopReset = current.onReset(() => {
      for (const integrationId of Array.from(flowsRef.current.keys())) update(integrationId, connectReset)
    })
    return () => {
      stopFinished()
      stopReset()
    }
  }, [connected, connection, update])

  // A flow still waiting when the surface closes is stopped on the host.
  useEffect(() => () => {
    const current = app.connections.connection(hostId)
    for (const state of flowsRef.current.values()) {
      if (state.step === 'waiting') void current?.api.integrationConnectCancel({ flowId: state.flowId }).catch(() => undefined)
    }
  }, [app, hostId])

  const nextAttempt = (integrationId: string) => {
    const attempt = (attempts.current.get(integrationId) ?? 0) + 1
    attempts.current.set(integrationId, attempt)
    return attempt
  }

  const connect = useCallback(async (integrationId: string, name: string): Promise<void> => {
    const current = connection()
    const previous = flowsRef.current.get(integrationId)
    if (previous?.step === 'waiting') void current?.api.integrationConnectCancel({ flowId: previous.flowId }).catch(() => undefined)
    const attempt = nextAttempt(integrationId)
    names.current.set(integrationId, name)
    if (!current) return put(integrationId, connectRefused('This host cannot be reached now.'))
    put(integrationId, { step: 'starting' })
    try {
      const result = await current.api.integrationConnectStart({ id: integrationId })
      if (attempt !== attempts.current.get(integrationId)) {
        // Closed while it started: the host stops waiting too.
        if (result.kind === 'waiting') void current.api.integrationConnectCancel({ flowId: result.flowId }).catch(() => undefined)
        return
      }
      put(integrationId, connectStarted(result, name))
    } catch (cause) {
      if (attempt === attempts.current.get(integrationId)) put(integrationId, connectRefused(errorMessage(cause)))
    }
  }, [connection, put])

  /** Opens the sign-in page of a waiting flow in the system browser. */
  const openSignIn = useCallback((integrationId: string) => {
    const state = flowsRef.current.get(integrationId)
    if (state?.step !== 'waiting') return
    app.platform.openBrowser(state.url).catch((cause: unknown) => update(integrationId, (latest) => connectFailed(latest, errorMessage(cause))))
  }, [app, update])

  /** Hands the host the address the browser ended on, or the API key. */
  const submit = useCallback(async (integrationId: string, value: string): Promise<void> => {
    const current = connection()
    const state = flowsRef.current.get(integrationId)
    const trimmed = value.trim()
    if (!current || (state?.step !== 'waiting' && state?.step !== 'token') || state.busy || !trimmed) return
    const request = state.step === 'waiting' ? { flowId: state.flowId, value: trimmed } : { id: integrationId, value: trimmed }
    const attempt = attempts.current.get(integrationId)
    const name = names.current.get(integrationId) ?? 'the integration'
    put(integrationId, connectSubmitting(state))
    try {
      await current.api.integrationConnectSubmit(request)
      if (attempt === attempts.current.get(integrationId)) update(integrationId, (latest) => connectSubmitted(latest, name))
    } catch (cause) {
      if (attempt === attempts.current.get(integrationId)) update(integrationId, (latest) => connectFailed(latest, errorMessage(cause)))
    }
  }, [connection, put, update])

  /** Stops a waiting flow on the host and closes it; any other flow just closes. */
  const cancel = useCallback(async (integrationId: string): Promise<void> => {
    const state = flowsRef.current.get(integrationId)
    if (state?.step !== 'waiting') {
      nextAttempt(integrationId)
      return put(integrationId, null)
    }
    const current = connection()
    if (!current) return update(integrationId, (latest) => connectFailed(latest, 'This host cannot be reached now.'))
    put(integrationId, { ...state, busy: true, error: null })
    try {
      await current.api.integrationConnectCancel({ flowId: state.flowId })
      nextAttempt(integrationId)
      put(integrationId, null)
    } catch (cause) {
      update(integrationId, (latest) => connectFailed(latest, errorMessage(cause)))
    }
  }, [connection, put, update])

  return { connected, flows, connect, openSignIn, submit, cancel }
}

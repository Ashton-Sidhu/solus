import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { IntegrationSignIn } from '@solus/contracts/integrations/integration-sign-in'
import { DEFAULT_INTEGRATION_ACCOUNT } from '@solus/contracts/integration-types'
import { useFocusEffect } from '@react-navigation/native'
import type { HostApi } from '@solus/client-core/host-api'
import { CommandProcesses } from '@solus/client-core/command-processes'
import { showsFactsOnRow, type CommandProcessActionKind, type CommandProcessStatus } from '@solus/contracts/integrations/command-server'
import type { CatalogCategoryId, Integration, IntegrationCatalogListRequest, IntegrationCommandCreateRequest, IntegrationConnection, IntegrationEnvValue, IntegrationLaunch, IntegrationOAuthClientInput } from '@solus/contracts/integration-types'
import { useApp, useListened } from '../../app/app-context'
import {
  appendCatalogEntries,
  CATALOG_PAGE_SIZE,
  connectFailed,
  connectFinished,
  connectionMap,
  connectRefused,
  connectReset,
  connectsThroughCloud,
  connectStarted,
  connectSubmitted,
  connectSubmitting,
  errorMessage,
  isUnsupportedMethodError,
  InstalledIntegration,
  probeRefusal,
  sortIntegrations,
  upsertIntegration,
  withConnection,
  withExtraAccount,
  extraAccountMap,
  withoutKey,
  withAddFinished,
  stoppedAdd,
  type AddingAccount,
  withoutIntegration,
  type AddState,
  type CatalogState,
  type ConnectFlowState,
  type ConnectionListState,
  type ConnectTarget,
  type IntegrationAction,
  type IntegrationCandidate,
  type IntegrationListState,
  type IntegrationToolsState,
} from './integrations'
import { CloudConnect } from './lib/cloud-connect'
import { timerClock } from '../account/account-sync'
import { runningServers } from '../running-servers/running-servers.store'

const CATALOG_DELAY_MS = 250

/**
 * The MCP servers of one host for its MCP screen. Read on connect, on focus,
 * and on reconnect; `integration.changed` reads the list again and, on
 * `tools` or `facts`, the open server's details. A reply that arrives after a newer
 * request, or from a connection that has gone, is dropped. A change the host
 * refused throws; the screen says why. The person's own connections are read
 * beside the list and follow `integration.connectionChanged`; the connect
 * flows are `useIntegrationConnect`'s. Tools are read only for an open row
 * whose server can answer (`mayLoadTools`), so a server that is not connected
 * never shows an error for them.
 *
 * `processes` are the person's processes of the commands
 * (docs/plans/mcp-first-class.md §7.7): the client-core `CommandProcesses`,
 * with the one facts map of every row, as desktop and web keep them. The facts
 * of each command and loopback server are read with the list, on a reconnect,
 * and again on `integration.changed`, so a start or stop on another client
 * shows here too. A read starts no command. `mayRunCommands` is the person's
 * `host.admin`: without it the screen offers no add, edit, or start. While the
 * screen is open it holds the host's running-servers lease, so the host
 * follows the servers on its loopback and looks for new ones (§9.1).
 */
export function useIntegrations(hostId: string) {
  const app = useApp()
  const readiness = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness)
  const connected = readiness === 'ready'
  const [list, setList] = useState<IntegrationListState>({ kind: 'loading' })
  const [connections, setConnections] = useState<ConnectionListState>({ kind: 'loading' })
  /** The person's accounts after the first, by integration (§13.3). */
  const [extraAccounts, setExtraAccounts] = useState<ReadonlyMap<string, readonly IntegrationConnection[]>>(new Map())
  /** By integration: an "Add another account" that runs (its sign-in page) or stopped (why). */
  const [addingAccount, setAddingAccount] = useState<ReadonlyMap<string, AddingAccount>>(new Map())
  const flows = useIntegrationConnect(hostId)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [tools, setTools] = useState<ReadonlyMap<string, IntegrationToolsState>>(new Map())
  const [catalog, setCatalog] = useState<CatalogState>({ kind: 'idle' })
  const [category, setCategoryState] = useState<CatalogCategoryId | null>(null)
  /** The same category, read by the catalog requests. */
  const categoryRef = useRef<CatalogCategoryId | null>(null)
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
  const connectionsRef = useRef(connections)
  // A layout effect runs before every passive effect of the same commit, so
  // handlers and effects still read this render's values. A write during
  // render would stop the React Compiler.
  useLayoutEffect(() => {
    listRef.current = list
    connectionsRef.current = connections
  })

  const connection = useCallback(() => app.connections.connection(hostId), [app, hostId])

  const mayRunCommands = useListened(app.connections.changes, () => app.connections.may(hostId, 'host.admin'))
  /** Bumped by each change of the processes, so the screen renders their new state. */
  const [processesVersion, setProcessesVersion] = useState(0)
  const processes = useMemo(() => new CommandProcesses({
    api: () => app.connections.connection(hostId)?.api ?? null,
    facts: new Map(),
    starting: new Set(),
    errors: new Map(),
    onChange: () => setProcessesVersion((previous) => previous + 1),
    // A loopback server that runs again lists its tools in an open row, not the error of when it stopped (§9.3).
    onFacts: (integrationId, answer) => {
      if (answer.reachable === 'running') setTools((previous) => (previous.get(integrationId)?.kind === 'error' ? withoutKey(previous, integrationId) : previous))
    },
    // A started command lists its tools for its open row (§7.7): the row's tools are read again.
    onStarted: (integrationId) => setTools((previous) => (previous.has(integrationId) ? withoutKey(previous, integrationId) : previous)),
  }), [app, hostId])

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
        setExtraAccounts(extraAccountMap(own))
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

  /** Reads the tools of an open row, and its facts, only when its server can answer. False when it does not read. */
  const loadTools = useCallback((integrationId: string) => {
    const current = connection()
    const state = listRef.current
    const integration = state.kind === 'loaded' ? state.integrations.find((entry) => entry.id === integrationId) : undefined
    if (!current || !openIds.current.has(integrationId) || !integration || !new InstalledIntegration(integration).mayLoadTools(connectionsRef.current)) return false
    const request = (toolsRequests.current.get(integrationId) ?? 0) + 1
    toolsRequests.current.set(integrationId, request)
    const put = (next: IntegrationToolsState) => {
      if (toolsRequests.current.get(integrationId) !== request || !openIds.current.has(integrationId)) return
      setTools((previous) => new Map(previous).set(integrationId, next))
    }
    setTools((previous) => (previous.get(integrationId)?.kind === 'loaded' ? previous : new Map(previous).set(integrationId, { kind: 'loading' })))
    // The facts only add the instructions and the CLI copies left out: a facts read that fails, or an older host without it, keeps the tools.
    void processes.load(integrationId)
    current.api.integrationTools({ id: integrationId }).then(
      (summaries) => put({ kind: 'loaded', tools: summaries }),
      (cause: unknown) => put({ kind: 'error', message: errorMessage(cause) }),
    )
    return true
  }, [connection, processes])

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
      const allowed = new InstalledIntegration(integration).mayLoadTools(connections)
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

  useEffect(() => runningServers.forHost(app.connections, hostId).retain(), [app, hostId])

  const commandIds = list.kind === 'loaded' ? list.integrations.filter(showsFactsOnRow).map((integration) => integration.id).join('\u0000') : ''

  // The list, a reconnect, or a change of the commands: each command's state is read again.
  useEffect(() => {
    if (!connected || !commandIds) return
    for (const integrationId of commandIds.split('\u0000')) void processes.load(integrationId)
  }, [connected, commandIds, processes])

  useEffect(() => {
    const current = connected ? connection() : null
    if (!current) return
    return current.events.subscribe('integration.changed', ({ integrationId, change }) => {
      if (change === 'removed') collapse(integrationId)
      // A command's process state, and whether a loopback server runs, show on its row, open or not.
      const state = listRef.current
      const showsFacts = change !== 'removed' && state.kind === 'loaded' && showsFactsOnRow(state.integrations.find((entry) => entry.id === integrationId))
      if (change === 'tools' || change === 'facts') {
        // An open row reads the facts with its tools.
        if (!loadTools(integrationId) && showsFacts) void processes.load(integrationId)
        return
      }
      if (showsFacts) void processes.load(integrationId)
      reload()
    })
  }, [connected, connection, reload, loadTools, collapse, processes])

  useEffect(() => {
    const current = connected ? connection() : null
    if (!current) return
    return current.events.subscribe('integration.connectionChanged', ({ integrationId, accountId, connection: changed }) => {
      const account = changed?.accountId ?? accountId ?? DEFAULT_INTEGRATION_ACCOUNT
      if (account !== DEFAULT_INTEGRATION_ACCOUNT) {
        setExtraAccounts((latest) => withExtraAccount(latest, integrationId, account, changed))
        if (changed?.status === 'connected') setAddingAccount((latest) => withoutKey(latest, integrationId))
        return
      }
      // A read in flight may be older than this change; the event wins.
      connectionsRequest.current++
      setConnections((state) => ({
        kind: 'loaded',
        byIntegration: withConnection(state.kind === 'loaded' ? state.byIntegration : new Map<string, IntegrationConnection>(), integrationId, changed),
      }))
    })
  }, [connected, connection])

  // An add whose sign-in failed or was cancelled on the host stops; a connected one ends with its account.
  useEffect(() => {
    const current = connected ? connection() : null
    if (!current) return
    return current.events.subscribe('host.integrationAuthFinished', (event) => setAddingAccount((latest) => withAddFinished(latest, event)))
  }, [connected, connection])

  useEffect(() => () => {
    if (catalogTimer.current) clearTimeout(catalogTimer.current)
  }, [])

  /** One page of the catalog in the chosen category; a host from before categories refuses the field, so it is sent only when set. */
  const catalogPage = useCallback((api: HostApi, query: string, offset: number) => {
    const request: IntegrationCatalogListRequest = { query: query || undefined, offset, limit: CATALOG_PAGE_SIZE }
    if (categoryRef.current) request.category = categoryRef.current
    return api.integrationCatalogList(request)
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
      catalogPage(current.api, trimmed, 0).then(
        (page) => { if (request === catalogRequest.current) setCatalog({ kind: 'loaded', query: trimmed, entries: page.entries, total: page.total, loadingMore: false, searching: false }) },
        (cause: unknown) => { if (request === catalogRequest.current) setCatalog({ kind: 'error', query: trimmed, message: errorMessage(cause) }) },
      )
    }, delay)
  }, [connection, catalogPage])

  /** Searches the catalog after a short pause in typing. */
  const searchCatalog = useCallback((query: string) => readCatalog(query, CATALOG_DELAY_MS), [readCatalog])

  /** Reads the same search again at once, after an error. */
  const retryCatalog = useCallback((query: string) => readCatalog(query, 0), [readCatalog])

  /** Lists one category of the catalog, or every entry with null, for the current search. */
  const setCategory = useCallback((next: CatalogCategoryId | null, query: string) => {
    categoryRef.current = next
    setCategoryState(next)
    readCatalog(query, 0)
  }, [readCatalog])

  /** Adds the next page below the entries shown, so nothing above them moves. */
  const loadMoreCatalog = useCallback(() => {
    const state = catalog
    const current = connection()
    if (!current || state.kind !== 'loaded' || state.loadingMore || state.searching || state.entries.length >= state.total) return
    const request = catalogRequest.current
    setCatalog({ ...state, loadingMore: true })
    catalogPage(current.api, state.query, state.entries.length).then(
      (page) => {
        if (request !== catalogRequest.current) return
        setCatalog((latest) => latest.kind === 'loaded'
          ? { ...latest, entries: appendCatalogEntries(latest.entries, page.entries), total: page.total, loadingMore: false }
          : latest)
      },
      // The entries stay; Show more asks again.
      () => { if (request === catalogRequest.current) setCatalog((latest) => latest.kind === 'loaded' ? { ...latest, loadingMore: false } : latest) },
    )
  }, [catalog, connection, catalogPage])

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
    // The React Compiler cannot compile try/finally. The async wrapper turns a
    // synchronous throw into a rejection, so finally sees both.
    return await (async () => run(current.api))().finally(() => {
      busyRef.current = null
      setBusy(null)
    })
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
    // The React Compiler cannot compile try/finally or a throw inside try. The
    // async wrapper turns a synchronous throw into a rejection, so catch and
    // finally see both.
    return await (async (): Promise<Integration | null> => {
      const current = connection()
      if (!current || !connected) throw new Error('This host cannot be reached now.')
      const probe = await current.api.integrationProbe({ url })
      const refusal = probeRefusal(probe)
      if (refusal) {
        const setupNeed = IntegrationSignIn.setupNeedOfProbe(probe, url)
        setAdding(setupNeed ? { url, step: 'failed', message: refusal, setupNeed } : { url, step: 'failed', message: refusal })
        return null
      }
      const integration = await change('create', (api) => api.integrationCreate(candidate))
      applyToList((integrations) => upsertIntegration(integrations, integration))
      setAdding(null)
      return integration
    })().catch((cause) => {
      setAdding({ url, step: 'failed', message: errorMessage(cause) })
      return null
    }).finally(() => {
      addingRef.current = false
    })
  }

  const clearAdding = useCallback(() => setAdding(null), [])

  /**
   * Adds a command (mcp-first-class.md §7.7). The host refuses a person
   * without `host.admin`; the screen offers no form to them. Starts nothing.
   */
  const addCommand = async (request: IntegrationCommandCreateRequest): Promise<Integration> => {
    const integration = await change('create', (api) => api.integrationCreate(request))
    applyToList((integrations) => upsertIntegration(integrations, integration))
    return integration
  }

  /** A new line, folder, or names for a command: the host stops it and drops its facts; new names remove the values. */
  const editCommand = async (integrationId: string, launch: IntegrationLaunch, envNames?: string[]): Promise<void> => {
    const integration = await change(`command:${integrationId}`, (api) => api.integrationUpdate(envNames ? { id: integrationId, launch, envNames } : { id: integrationId, launch }))
    applyToList((integrations) => upsertIntegration(integrations, integration))
  }

  const rename = async (integrationId: string, name: string): Promise<void> => {
    const integration = await change(`rename:${integrationId}`, (api) => api.integrationUpdate({ id: integrationId, name }))
    applyToList((integrations) => upsertIntegration(integrations, integration))
  }

  const remove = async (integrationId: string): Promise<void> => {
    await change(`remove:${integrationId}`, (api) => api.integrationRemove({ id: integrationId }))
    collapse(integrationId)
    applyToList((integrations) => withoutIntegration(integrations, integrationId))
  }

  /**
   * Removes the person's own token and connection; the row follows
   * `integration.connectionChanged`. A connection the account holds leaves the
   * account (plans/020 §5.3), and the hosts learn on their pull.
   */
  const disconnect = async (integrationId: string): Promise<void> => {
    const state = listRef.current
    const integration = state.kind === 'loaded' ? state.integrations.find((entry) => entry.id === integrationId) : undefined
    const own = connectionsRef.current.kind === 'loaded' ? connectionsRef.current.byIntegration.get(integrationId) : undefined
    if (own?.source === 'cloud' && integration) await change(`disconnect:${integrationId}`, () => flows.disconnectCloud(integration.url))
    else await change(`disconnect:${integrationId}`, (api) => api.integrationDisconnect({ id: integrationId }))
    setConnections((latest) => (latest.kind === 'loaded' ? { kind: 'loaded', byIntegration: withConnection(latest.byIntegration, integrationId, null) } : latest))
  }

  /** Signs in one more account in the browser (§13.3); the new account arrives as `integration.connectionChanged`. */
  const addAccount = (integrationId: string): void => {
    const current = connection()
    if (!current || !connected) return
    setAddingAccount((latest) => new Map(latest).set(integrationId, { flowId: null, url: null, error: '' }))
    const callbackBaseUrl = new URL(current.transport.serverUrl.replace(/^ws/, 'http')).origin
    current.api.integrationConnectStart({ id: integrationId, newAccount: true, callbackBaseUrl }).then((result) => {
      if (result.kind !== 'waiting') {
        setAddingAccount((latest) => new Map(latest).set(integrationId, stoppedAdd('This server takes one API key per person.')))
        return
      }
      setAddingAccount((latest) => new Map(latest).set(integrationId, { flowId: result.flowId, url: result.url, error: '' }))
      return app.platform.openBrowser(result.url)
    }).catch((cause: unknown) => {
      setAddingAccount((latest) => new Map(latest).set(integrationId, stoppedAdd(errorMessage(cause))))
    })
  }

  /** Stops the add here and its sign-in on the host. */
  const cancelAddAccount = (integrationId: string): void => {
    const flowId = addingAccount.get(integrationId)?.flowId
    setAddingAccount((latest) => withoutKey(latest, integrationId))
    if (flowId) void connection()?.api.integrationConnectCancel({ flowId }).catch(() => undefined)
  }

  /** Opens the waiting add's sign-in page again. */
  const reopenAddAccount = (integrationId: string): void => {
    const url = addingAccount.get(integrationId)?.url
    if (url) app.platform.openBrowser(url).catch(() => undefined)
  }

  /** Disconnects one account after the first; the first is `disconnect`'s. */
  const disconnectAccount = async (integrationId: string, accountId: string): Promise<void> => {
    await change(`disconnect:${integrationId}`, (api) => api.integrationDisconnect({ id: integrationId, accountId }))
    setExtraAccounts((latest) => withExtraAccount(latest, integrationId, accountId, null))
  }

  /**
   * Saves the administrator's OAuth client, or removes it with null. The
   * secret goes to the host once; only the host's record, which says whether
   * a secret is saved, lands in the list.
   */
  const setOAuthClient = async (integrationId: string, oauthClient: IntegrationOAuthClientInput | null): Promise<void> => {
    await flows.cancel(integrationId)
    const integration = await change(`oauth-client:${integrationId}`, (api) => api.integrationUpdate({ id: integrationId, oauthClient }))
    applyToList((integrations) => upsertIntegration(integrations, integration))
  }

  /** Turns one tool on or off for agents; the host keeps the list on the server's record. */
  const setToolEnabled = async (integration: Integration, toolName: string, isOn: boolean): Promise<void> => {
    const disabled = new Set(integration.disabledTools)
    if (isOn) disabled.delete(toolName)
    else disabled.add(toolName)
    const updated = await change(`tools:${integration.id}`, (api) => api.integrationUpdate({ id: integration.id, disabledTools: [...disabled] }))
    applyToList((integrations) => upsertIntegration(integrations, updated))
  }

  /** Turns every listed tool off, or all of them on (mcp-first-class.md §8.8). A tool the server adds later is on. */
  const setAllTools = async (integration: Integration, isOn: boolean): Promise<void> => {
    const listed = tools.get(integration.id)
    const names = isOn ? [] : listed?.kind === 'loaded' ? listed.tools.map((tool) => tool.name) : []
    if (!isOn && names.length === 0) throw new Error('Open the server to read its tools first.')
    const updated = await change(`tools:${integration.id}`, (api) => api.integrationUpdate({ id: integration.id, disabledTools: names }))
    applyToList((integrations) => upsertIntegration(integrations, updated))
  }

  // A new object at each change: the rows read it as a new prop and render the new state.
  const processesView = useMemo(() => ({
    connected,
    mayRunCommands,
    /** Start and test, or Start again. */
    start: (integrationId: string) => processes.start(integrationId),
    run: (integrationId: string, kind: CommandProcessActionKind) => { void processes.run(integrationId, kind) },
    errorOf: (integrationId: string) => processes.errorOf(integrationId),
    /** The last facts the host gave for the server: its instructions, and the CLI copies left out. */
    factsOf: (integrationId: string) => processes.factsOf(integrationId),
    /** A command's process state for its row, or null for a server at an address. */
    statusOf: (integration: Integration, connection: IntegrationConnection | undefined): CommandProcessStatus | null => processes.statusOf(integration, connection, mayRunCommands),
    isNotRunning: (integration: Integration) => processes.isNotRunning(integration),
    // `processesVersion` is read for its change: the processes changed.
  }), [connected, mayRunCommands, processes, processesVersion])

  const hostUrl = connection()?.transport.serverUrl
  const oauthRedirectUrl = hostUrl ? `${new URL(hostUrl.replace(/^ws/, 'http')).origin}/oauth/integration/callback` : ''

  return {
    hostId,
    extraAccounts,
    addingAccount,
    addAccount,
    cancelAddAccount,
    reopenAddAccount,
    disconnectAccount,
    oauthRedirectUrl,
    connected,
    list,
    connections,
    flows,
    expanded,
    tools,
    catalog,
    category,
    adding,
    busy,
    reload,
    expand,
    toggle,
    searchCatalog,
    retryCatalog,
    setCategory,
    loadMoreCatalog,
    clearCatalog,
    add,
    clearAdding,
    addCommand,
    editCommand,
    rename,
    remove,
    disconnect,
    setOAuthClient,
    setToolEnabled,
    setAllTools,
    processes: processesView,
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
 * Signed in, the person signs in at Solus Cloud instead (plans/020 §5.3,
 * `CloudConnect`); the same flow states show it.
 */
export function useIntegrationConnect(hostId: string) {
  const app = useApp()
  const readiness = useListened(app.connections.changes, () => app.connections.state(hostId)?.readiness)
  const connected = readiness === 'ready'
  const accountUserId = useListened(app.account.changes, () => (app.account.view.kind === 'signed-in' ? app.account.view.identity.sub : null))
  const [flows, setFlows] = useState<ReadonlyMap<string, ConnectFlowState>>(new Map())
  /** The same flows, read at once by the event handlers and the commands. */
  const flowsRef = useRef(new Map<string, ConnectFlowState>())
  /** The name each flow speaks of, kept from Connect. */
  const names = useRef(new Map<string, string>())
  /** Bumps on each Connect and close; an answer for an older one is dropped. */
  const attempts = useRef(new Map<string, number>())
  /** Who is signed in, read when Connect is tapped. */
  const cloudRule = useRef({ accountUserId })
  cloudRule.current = { accountUserId }

  const connection = useCallback(() => app.connections.connection(hostId), [app, hostId])

  const put = useCallback((integrationId: string, next: ConnectFlowState | null) => {
    if (next) flowsRef.current.set(integrationId, next)
    else flowsRef.current.delete(integrationId)
    setFlows(new Map(flowsRef.current))
  }, [])

  const cloud = useMemo(() => new CloudConnect({
    requests: app.account.agentProfileRequests(),
    openBrowser: (url) => app.platform.openBrowser(url),
    pullEverywhere: () => app.accountSync.pullEverywhere(),
    clock: timerClock,
  }, put), [app, put])
  useEffect(() => () => cloud.dispose(), [cloud])

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
      if (state.step === 'waiting' && state.through === 'host') void current?.api.integrationConnectCancel({ flowId: state.flowId }).catch(() => undefined)
    }
  }, [app, hostId])

  const nextAttempt = (integrationId: string) => {
    const attempt = (attempts.current.get(integrationId) ?? 0) + 1
    attempts.current.set(integrationId, attempt)
    return attempt
  }

  const connect = useCallback(async (target: ConnectTarget): Promise<void> => {
    const { id: integrationId, name } = target
    const current = connection()
    const previous = flowsRef.current.get(integrationId)
    if (previous?.step === 'waiting' && previous.through === 'host') void current?.api.integrationConnectCancel({ flowId: previous.flowId }).catch(() => undefined)
    const attempt = nextAttempt(integrationId)
    names.current.set(integrationId, name)
    // The conversation's sheet names only an id: a signed-in person's sign-in needs the record's address and auth.
    const record = target.auth === undefined && cloudRule.current.accountUserId !== null
      ? await current?.api.integrationGet({ id: integrationId }).catch(() => null) ?? target
      : target
    if (attempt !== attempts.current.get(integrationId)) return
    if (record.url !== undefined && record.auth !== undefined && connectsThroughCloud(record, cloudRule.current.accountUserId)) {
      return cloud.start(integrationId, record.url, name, record.auth)
    }
    cloud.cancel(integrationId)
    if (!current) return put(integrationId, connectRefused('This host cannot be reached now.'))
    put(integrationId, { step: 'starting' })
    try {
      const result = await current.api.integrationConnectStart({ id: integrationId, callbackBaseUrl: new URL(current.transport.serverUrl.replace(/^ws/, 'http')).origin })
      if (attempt !== attempts.current.get(integrationId)) {
        // Closed while it started: the host stops waiting too.
        if (result.kind === 'waiting') void current.api.integrationConnectCancel({ flowId: result.flowId }).catch(() => undefined)
        return
      }
      put(integrationId, connectStarted(result, name))
    } catch (cause) {
      if (attempt === attempts.current.get(integrationId)) put(integrationId, connectRefused(errorMessage(cause)))
    }
  }, [cloud, connection, put])

  /** Opens the sign-in page of a waiting flow in the system browser. */
  const openSignIn = useCallback((integrationId: string) => {
    const state = flowsRef.current.get(integrationId)
    if (state?.step !== 'waiting') return
    if (state.through === 'cloud') return cloud.open(integrationId)
    app.platform.openBrowser(state.url).catch((cause: unknown) => update(integrationId, (latest) => connectFailed(latest, errorMessage(cause))))
  }, [app, cloud, update])

  /** Hands the host the address the browser ended on, or the API key; a cloud flow's key goes to the account. */
  const submit = useCallback(async (integrationId: string, value: string): Promise<void> => {
    const current = connection()
    const state = flowsRef.current.get(integrationId)
    const trimmed = value.trim()
    if (state?.step === 'token' && state.through === 'cloud') return cloud.submitKey(integrationId, trimmed)
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
  }, [cloud, connection, put, update])

  /** Hands the host a command's environment values, one for each name. They are never kept here (§7.7). */
  const submitValues = useCallback(async (integrationId: string, values: IntegrationEnvValue[]): Promise<void> => {
    const current = connection()
    const state = flowsRef.current.get(integrationId)
    if (!current || state?.step !== 'values' || state.busy) return
    const attempt = attempts.current.get(integrationId)
    const name = names.current.get(integrationId) ?? 'the server'
    put(integrationId, connectSubmitting(state))
    try {
      await current.api.integrationConnectSubmit({ id: integrationId, values })
      if (attempt === attempts.current.get(integrationId)) update(integrationId, (latest) => connectSubmitted(latest, name))
    } catch (cause) {
      if (attempt === attempts.current.get(integrationId)) update(integrationId, (latest) => connectFailed(latest, errorMessage(cause)))
    }
  }, [connection, put, update])

  /** Stops a waiting flow on the host and closes it; any other flow just closes. */
  const cancel = useCallback(async (integrationId: string): Promise<void> => {
    const state = flowsRef.current.get(integrationId)
    if (cloud.has(integrationId)) {
      nextAttempt(integrationId)
      return cloud.cancel(integrationId)
    }
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
  }, [cloud, connection, put, update])

  /** Removes a connection the account holds; every host reads the change on its pull. */
  const disconnectCloud = useCallback((serverUrl: string): Promise<void> => cloud.disconnect(serverUrl), [cloud])

  return { connected, flows, connect, openSignIn, submit, submitValues, cancel, disconnectCloud }
}

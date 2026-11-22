import type { FoundFile, DiscoveredHost, DiscoveredHostResult, FoundPlace, FoundServer, FoundServerList, IntegrationFoundAddResult, IntegrationFoundChange, IntegrationToolSummary } from '@solus/contracts/integration-types'
import { randomId } from '@solus/client-core/random-id'
import { serverConnections } from '@solus/client-core/server-connections'
import { SvelteMap } from 'svelte/reactivity'
import { isUnsupportedHostError } from './integration-sign-ins.svelte'

/** A test of a found server: it runs, it read the tools, or it failed with why. */
export type FoundTest = { kind: 'running' } | { kind: 'tools'; tools: IntegrationToolSummary[] } | { kind: 'failed'; message: string }

/**
 * The MCP servers in the config files of one host, and those that run on its
 * loopback (docs/plans/mcp-first-class.md §8.6, §8.8, §9.2, §8.9): its list as
 * the last discovery answered, the add, a test, and a change in a file. The page's
 * host reads the files of the other hosts for this client, and an action on
 * another host goes there through it; this client never sees a value of a
 * file. `hostId` is null for the page's host.
 */
export class McpFound {
  servers = $state<FoundServer[]>([])
  files = $state<FoundFile[]>([])
  /** Whether the host could look for servers on its loopback; absent from a host before phase D. */
  portScan = $state<FoundServerList['portScan']>()
  /** The caller is a host administrator there: they may test a server and change its files (§8.8). */
  mayChange = $state(false)
  /** No answer has arrived yet. */
  loading = $state(true)
  error = $state('')
  /** The host is older than found servers. */
  isUnsupported = $state(false)
  /** The foundId of the add that runs. */
  adding = $state<string | null>(null)
  /** The foundId of the change in a file that runs. */
  changing = $state<string | null>(null)
  /** The last test of each server, by foundId, until the person closes it. */
  readonly tests = new SvelteMap<string, FoundTest>()

  constructor(
    private readonly pageServerId: string,
    readonly host: DiscoveredHost,
    private readonly projectPath: string | null,
    /** Reads every host again: after an action, the lists of the hosts can differ. Each list comes when its host answers, so an action does not wait for it. */
    private readonly rediscover: () => Promise<void>,
  ) {}

  get hostId(): string | null {
    return this.host.hostId
  }

  /** The servers a group lists: the ones Solus does not have there. An added one is on that host's Installed list. */
  get notAdded(): FoundServer[] {
    return this.servers.filter((server) => server.state !== 'added')
  }

  /** The found server an installed integration came from, for its file actions on the Installed row. */
  forIntegration(integrationId: string): FoundServer | null {
    return this.servers.find((server) => server.state === 'added' && server.integrationId === integrationId) ?? null
  }

  /** The files that could not be read, each with why. */
  get problems(): FoundFile[] {
    return this.files.filter((file) => file.problem)
  }

  apply(result: DiscoveredHostResult): void {
    this.loading = false
    this.isUnsupported = result.kind === 'unsupported'
    this.error = result.kind === 'failed' ? result.message : ''
    if (result.kind !== 'loaded') return
    this.servers = result.list.servers
    this.files = result.list.files
    this.portScan = result.list.portScan
    this.mayChange = result.list.mayChange === true
  }

  /** Where an action goes: this host's project only on the page's host, and another host by its id. */
  private get target(): { hostId?: string; projectPath?: string } {
    return this.host.hostId ? { hostId: this.host.hostId } : { projectPath: this.projectPath ?? undefined }
  }

  /**
   * Adds what the person saw. When the file changed after they saw it, the
   * list is read again and the answer says so: the person reads the new entry
   * before an add.
   */
  async add(server: FoundServer, useFileValues: boolean): Promise<IntegrationFoundAddResult | { kind: 'failed'; message: string }> {
    this.adding = server.foundId
    try {
      const { hostId, projectPath } = this.target
      const result = await serverConnections.apiFor(this.pageServerId).integrationFoundAdd({
        foundId: server.foundId,
        fingerprint: server.fingerprint,
        hostId,
        projectPath: server.projectOnly ? projectPath : undefined,
        useFileValues: useFileValues || undefined,
      })
      // The page's host reads again on its own `integration.changed`; another host's change does not reach this client.
      if (result.kind === 'found-changed' || hostId) void this.rediscover()
      return result
    } catch (cause) {
      return { kind: 'failed', message: messageOf(cause) }
    } finally {
      this.adding = null
    }
  }

  /** Starts the server once and reads its tools (§8.8); the answer stays until `closeTest`. */
  async test(server: FoundServer): Promise<void> {
    this.tests.set(server.foundId, { kind: 'running' })
    try {
      const result = await serverConnections.apiFor(this.pageServerId).integrationFoundTest({ foundId: server.foundId, fingerprint: server.fingerprint, ...this.target })
      if (result.kind === 'found-changed') {
        this.tests.set(server.foundId, { kind: 'failed', message: 'It changed in its file. Read it again before you test it.' })
        void this.rediscover()
        return
      }
      this.tests.set(server.foundId, { kind: 'tools', tools: result.tools })
    } catch (cause) {
      this.tests.set(server.foundId, { kind: 'failed', message: messageOf(cause) })
    }
  }

  closeTest(foundId: string): void {
    this.tests.delete(foundId)
  }

  /** Turns the server off or on in one file, or deletes it there (§8.8). The error's words, or null when it is done. */
  async change(server: FoundServer, place: FoundPlace, change: IntegrationFoundChange): Promise<string | null> {
    this.changing = server.foundId
    try {
      const result = await serverConnections.apiFor(this.pageServerId).integrationFoundChange({
        foundId: server.foundId,
        fingerprint: server.fingerprint,
        ...this.target,
        place: { file: place.file, path: place.path, name: place.name },
        change,
      })
      void this.rediscover()
      return result.kind === 'found-changed' ? 'It changed in its file. Read it again, then try again.' : null
    } catch (cause) {
      return messageOf(cause)
    } finally {
      this.changing = null
    }
  }
}

/**
 * The servers found on the page's host and on each other host it reaches for
 * the person (§8.9), as one discovery: the page's host asks the others, and each
 * host's list shows as soon as it arrives, so a slow or absent host holds back
 * only its own group. It discovers again when an integration changes and when the
 * host reconnects. Ephemeral: it lives as long as the MCP page.
 */
export class McpDiscovery {
  /** The groups in the discovery's order: the page's host first. */
  hosts = $state<McpFound[]>([])
  /** A discovery runs; the groups stay. */
  refreshing = $state(false)
  readonly self: McpFound
  private discoveryId = ''
  private readonly stops: Array<() => void>

  constructor(private readonly serverId: string, private readonly projectPath: string | null) {
    this.self = new McpFound(serverId, { hostId: null, label: '' }, projectPath, () => this.discover(true))
    this.hosts = [this.self]
    const events = serverConnections.eventsFor(serverId)
    this.stops = [
      // An answer can come before the discovery's own: it names its host.
      events.subscribe('integration.discovered', (event) => {
        if (event.discoveryId === this.discoveryId) this.groupFor(event.host).apply(event.result)
      }),
      events.subscribe('integration.changed', () => void this.discover()),
      serverConnections.onReadinessChange((hostId, status) => {
        if (hostId === serverId && status === 'ready') void this.discover(true)
      }),
    ]
    void this.discover()
  }

  /** Reads every host; `refresh` makes each read its files again, not its answer of the last 10 seconds. */
  async discover(refresh = false): Promise<void> {
    const discoveryId = randomId()
    this.discoveryId = discoveryId
    this.refreshing = true
    const api = serverConnections.apiFor(this.serverId)
    try {
      const { hosts } = await api.integrationDiscover({ discoveryId, projectPath: this.projectPath ?? undefined, refresh: refresh || undefined })
      if (discoveryId !== this.discoveryId) return
      // A host the page's host no longer reaches leaves the view.
      this.hosts = hosts.map((host) => this.groupFor(host))
    } catch (cause) {
      if (discoveryId !== this.discoveryId) return
      if (isUnsupportedHostError(cause)) await this.discoverSelfOnly(api, refresh, discoveryId)
      else this.self.apply({ kind: 'failed', message: messageOf(cause) })
    }
    if (discoveryId === this.discoveryId) this.refreshing = false
  }

  /** A host older than discovery reads only its own files. */
  private async discoverSelfOnly(api: ReturnType<typeof serverConnections.apiFor>, refresh: boolean, discoveryId: string): Promise<void> {
    this.hosts = [this.self]
    const result = await api.integrationFoundList({ projectPath: this.projectPath ?? undefined, refresh: refresh || undefined }).then(
      (list): DiscoveredHostResult => ({ kind: 'loaded', list }),
      (cause: unknown): DiscoveredHostResult => (isUnsupportedHostError(cause) ? { kind: 'unsupported' } : { kind: 'failed', message: messageOf(cause) }),
    )
    if (discoveryId === this.discoveryId) this.self.apply(result)
  }

  private groupFor(host: DiscoveredHost): McpFound {
    if (!host.hostId) return this.self
    const known = this.hosts.find((group) => group.hostId === host.hostId)
    if (known) return known
    const group = new McpFound(this.serverId, host, null, () => this.discover(true))
    this.hosts.push(group)
    return group
  }

  dispose(): void {
    this.discoveryId = ''
    for (const stop of this.stops) stop()
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error && cause.message.trim() ? cause.message.trim() : 'The host did not answer.'
}

import type { FoundFile, FoundServer, IntegrationFoundAddResult } from '@solus/contracts/integration-types'
import { serverConnections } from '@solus/client-core/server-connections'
import { isUnsupportedHostError } from '../integrations.store.svelte'

/**
 * The MCP servers in the config files of one host (docs/plans/mcp-first-class.md
 * §8.6): the list, Refresh, and the add. The host reads the files; this client
 * never sees a value of them. It reads again when an integration changes, so a
 * row turns `added` or `new` with the installed list, and when the host
 * reconnects. Ephemeral: it lives as long as the MCP page.
 */
export class McpFound {
  servers = $state<FoundServer[]>([])
  files = $state<FoundFile[]>([])
  /** No answer has arrived yet. */
  loading = $state(true)
  /** A Refresh runs; the rows stay. */
  refreshing = $state(false)
  error = $state('')
  /** The host is older than found servers. */
  isUnsupported = $state(false)
  /** The foundId of the add that runs. */
  adding = $state<string | null>(null)
  private sequence = 0
  private readonly stops: Array<() => void>

  constructor(private readonly serverId: string, private readonly projectPath: string | null) {
    const events = serverConnections.eventsFor(serverId)
    this.stops = [
      events.subscribe('integration.changed', () => void this.load()),
      serverConnections.onReadinessChange((hostId, status) => {
        if (hostId === serverId && status === 'ready') void this.load(true)
      }),
    ]
    void this.load()
  }

  /** The files that could not be read, each with why. */
  get problems(): FoundFile[] {
    return this.files.filter((file) => file.problem)
  }

  /** Reads the list; `refresh` makes the host read its files again, not its answer of the last 10 seconds. */
  async load(refresh = false): Promise<void> {
    const sequence = ++this.sequence
    if (refresh) this.refreshing = true
    try {
      const list = await serverConnections.apiFor(this.serverId).integrationFoundList({ projectPath: this.projectPath ?? undefined, refresh: refresh || undefined })
      if (sequence !== this.sequence) return
      this.servers = list.servers
      this.files = list.files
      this.error = ''
    } catch (cause) {
      if (sequence !== this.sequence) return
      if (isUnsupportedHostError(cause)) this.isUnsupported = true
      else this.error = cause instanceof Error && cause.message.trim() ? cause.message.trim() : 'The host did not answer.'
    }
    this.loading = false
    this.refreshing = false
  }

  /**
   * Adds what the person saw. When the file changed after they saw it, the
   * list is read again and the answer says so: the person reads the new entry
   * before an add.
   */
  async add(server: FoundServer, useFileValues: boolean): Promise<IntegrationFoundAddResult | { kind: 'failed'; message: string }> {
    this.adding = server.foundId
    try {
      const result = await serverConnections.apiFor(this.serverId).integrationFoundAdd({
        foundId: server.foundId,
        fingerprint: server.fingerprint,
        projectPath: server.projectOnly ? this.projectPath ?? undefined : undefined,
        useFileValues: useFileValues || undefined,
      })
      if (result.kind === 'found-changed') await this.load(true)
      return result
    } catch (cause) {
      return { kind: 'failed', message: cause instanceof Error && cause.message.trim() ? cause.message.trim() : 'The host did not answer.' }
    } finally {
      this.adding = null
    }
  }

  dispose(): void {
    this.sequence++
    for (const stop of this.stops) stop()
  }
}

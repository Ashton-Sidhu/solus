import { SvelteMap } from 'svelte/reactivity'
import type { OtelSettings, OtelSettingsSnapshot } from '@solus/contracts/types'
import type { HostApi } from '@solus/client-core/host-api'
import { createAppContext } from '../app/create-app-context'

/** Where a host sends its own telemetry, per host. Keyed by server because the
 *  exporter runs beside the server: two hosts a user is connected to can be
 *  shipping to different collectors, or one to none. */
export interface OtelSettingsHostContext {
  serverId: string
  api: Pick<HostApi, 'otelSettingsGet' | 'configUpdate'>
}

export class OtelSettingsStore {
  private readonly snapshots = new SvelteMap<string, OtelSettingsSnapshot>()
  private readonly loadingHosts = new SvelteMap<string, boolean>()
  private readonly errors = new SvelteMap<string, string | null>()
  private readonly loads = new Map<string, Promise<OtelSettingsSnapshot>>()

  snapshotFor(serverId: string): OtelSettingsSnapshot | null {
    return this.snapshots.get(serverId) ?? null
  }

  isLoading(serverId: string): boolean {
    return this.loadingHosts.get(serverId) === true
  }

  errorFor(serverId: string): string | null {
    return this.errors.get(serverId) ?? null
  }

  async load(
    host: OtelSettingsHostContext,
    options: { force?: boolean } = {},
  ): Promise<OtelSettingsSnapshot> {
    const cached = this.snapshots.get(host.serverId)
    if (cached && !options.force) return cached
    const pending = this.loads.get(host.serverId)
    if (pending && !options.force) return pending

    this.loadingHosts.set(host.serverId, true)
    this.errors.set(host.serverId, null)
    const promise = host.api.otelSettingsGet()
      .then((snapshot) => {
        this.snapshots.set(host.serverId, snapshot)
        return snapshot
      })
      .catch(() => {
        this.errors.set(host.serverId, 'Could not load telemetry settings.')
        throw new Error('Could not load telemetry settings.')
      })
      .finally(() => {
        this.loadingHosts.set(host.serverId, false)
        if (this.loads.get(host.serverId) === promise) this.loads.delete(host.serverId)
      })
    this.loads.set(host.serverId, promise)
    return promise
  }

  /**
   * Two calls, deliberately. The write goes through the one config surface, but
   * which signals are *actually* exporting is runtime state the config cannot
   * express — the host may be overridden by its environment — so the snapshot is
   * re-read rather than inferred from the patch.
   */
  async update(
    host: OtelSettingsHostContext,
    patch: Partial<OtelSettings>,
  ): Promise<OtelSettingsSnapshot> {
    this.errors.set(host.serverId, null)
    try {
      await host.api.configUpdate({ otel: patch })
      return await this.load(host, { force: true })
    } catch (error) {
      this.errors.set(
        host.serverId,
        error instanceof Error ? error.message : 'Could not save telemetry settings.',
      )
      throw error
    }
  }
}

export const [getOtelSettingsStore, setOtelSettingsStore] =
  createAppContext<OtelSettingsStore>('otel-settings')

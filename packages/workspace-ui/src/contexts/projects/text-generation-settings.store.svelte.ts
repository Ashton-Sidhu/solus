import { SvelteMap } from 'svelte/reactivity'
import type { TextGenerationSettingsSnapshot } from '@solus/contracts/types'
import type { HostApi } from '@solus/client-core/host-api'
import { createAppContext } from '../app/create-app-context'

export interface TextGenerationSettingsHostContext {
  serverId: string
  api: Pick<HostApi, 'textGenerationSettingsGet'>
}

/**
 * What one host offers for text generation: its installed models, and the model
 * it falls back to for a choice it lacks. The choices themselves are the
 * person's (`textGenerationModel`, `sourceControlWriterModel`,
 * `sourceControlWriting` in the personal settings) and travel with each request.
 */
export class TextGenerationSettingsStore {
  private readonly snapshots = new SvelteMap<string, TextGenerationSettingsSnapshot>()
  private readonly loadingHosts = new SvelteMap<string, boolean>()
  private readonly errors = new SvelteMap<string, string | null>()
  private readonly loads = new Map<string, Promise<TextGenerationSettingsSnapshot>>()

  snapshotFor(serverId: string): TextGenerationSettingsSnapshot | null {
    return this.snapshots.get(serverId) ?? null
  }

  isLoading(serverId: string): boolean {
    return this.loadingHosts.get(serverId) === true
  }

  errorFor(serverId: string): string | null {
    return this.errors.get(serverId) ?? null
  }

  async load(
    host: TextGenerationSettingsHostContext,
    options: { force?: boolean } = {},
  ): Promise<TextGenerationSettingsSnapshot> {
    const cached = this.snapshots.get(host.serverId)
    if (cached && !options.force) return cached
    const pending = this.loads.get(host.serverId)
    if (pending && !options.force) return pending

    this.loadingHosts.set(host.serverId, true)
    this.errors.set(host.serverId, null)
    const promise = host.api.textGenerationSettingsGet()
      .then((snapshot) => {
        this.snapshots.set(host.serverId, snapshot)
        return snapshot
      })
      .catch(() => {
        this.errors.set(
          host.serverId,
          'Could not load text-generation settings.',
        )
        throw new Error('Could not load text-generation settings.')
      })
      .finally(() => {
        this.loadingHosts.set(host.serverId, false)
        if (this.loads.get(host.serverId) === promise) this.loads.delete(host.serverId)
      })
    this.loads.set(host.serverId, promise)
    return promise
  }
}

export const [getTextGenerationSettingsStore, setTextGenerationSettingsStore] =
  createAppContext<TextGenerationSettingsStore>('text-generation-settings')

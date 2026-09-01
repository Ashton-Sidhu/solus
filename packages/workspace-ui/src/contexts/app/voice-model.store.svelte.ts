import { createAppContext } from './create-app-context'
import type { VoiceModelStatus } from '@solus/contracts/types'
import { serverConnections } from '@solus/client-core/server-connections'
import type { HostApi } from '@solus/client-core/host-api'
import { SvelteMap } from 'svelte/reactivity'

export class VoiceModelStore {
  /** Default-host mirror used by client-adjacent transcription controls. */
  status = $state<VoiceModelStatus>({ state: 'checking' })
  /**
   * False once the default host is known to have no transcription backend at
   * all — only the desktop main process registers `voiceModelStatus`, so a
   * standalone server can never transcribe. Distinct from `ready === false`,
   * which means the model is still downloading or failed: that earns a disabled
   * mic and a tooltip, while an absent backend earns no mic at all.
   */
  supported = $state(true)
  private readonly statusByHost = new SvelteMap<string, VoiceModelStatus>()
  private readonly supportedByHost = new SvelteMap<string, boolean>()

  ready = $derived(this.status.state === 'ready')
  progressPct = $derived(
    this.status.totalBytes && this.status.receivedBytes !== undefined
      ? Math.max(0, Math.min(100, Math.round(this.status.receivedBytes / this.status.totalBytes * 100)))
      : null,
  )

  apply(status: VoiceModelStatus, serverId?: string): void {
    if (serverId) this.statusByHost.set(serverId, status)
    if (!serverId || serverConnections.defaultServerId() === serverId) {
      this.status = status
    }
  }

  async refresh(serverId: string): Promise<void> {
    await this.refreshFor(serverId, serverConnections.apiFor(serverId))
  }

  async retry(serverId: string): Promise<void> {
    await this.retryFor(serverId, serverConnections.apiFor(serverId))
  }

  statusFor(serverId: string): VoiceModelStatus {
    return this.statusByHost.get(serverId) ?? { state: 'checking' }
  }

  /** Assume support until a host says otherwise, so the mic never flashes out on a host that has it. */
  supportedFor(serverId: string): boolean {
    return this.supportedByHost.get(serverId) ?? true
  }

  private applySupported(serverId: string, supported: boolean): void {
    this.supportedByHost.set(serverId, supported)
    if (serverConnections.defaultServerId() === serverId) this.supported = supported
  }

  progressFor(serverId: string): number | null {
    return progressPercent(this.statusFor(serverId))
  }

  async refreshFor(
    serverId: string,
    api: Pick<HostApi, 'voiceModelStatus'>,
  ): Promise<void> {
    const supported = (await serverConnections.capabilitiesFor(serverId)).voiceModel === true
    this.applySupported(serverId, supported)
    if (!supported) {
      this.apply({ state: 'error', error: 'Voice model is not supported on this host.' }, serverId)
      return
    }
    this.apply(await api.voiceModelStatus(), serverId)
  }

  async retryFor(
    serverId: string,
    api: Pick<HostApi, 'voiceModelRetry'>,
  ): Promise<void> {
    if ((await serverConnections.capabilitiesFor(serverId)).voiceModel !== true) return
    this.apply(await api.voiceModelRetry(), serverId)
  }
}

function progressPercent(status: VoiceModelStatus): number | null {
  return status.totalBytes && status.receivedBytes !== undefined
    ? Math.max(0, Math.min(100, Math.round(status.receivedBytes / status.totalBytes * 100)))
    : null
}

export function formatVoiceModelBytes(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Math.round(bytes / 1024 / 1024)} MB`
}

export const [getVoiceModelStore, setVoiceModelStore] = createAppContext<VoiceModelStore>('voice-model')

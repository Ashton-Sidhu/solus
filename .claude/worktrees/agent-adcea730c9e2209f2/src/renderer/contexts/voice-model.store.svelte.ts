import { createContext } from 'svelte'
import type { VoiceModelStatus } from '../../shared/types'

export class VoiceModelStore {
  status = $state<VoiceModelStatus>({ state: 'checking' })

  ready = $derived(this.status.state === 'ready')
  progressPct = $derived(
    this.status.totalBytes && this.status.receivedBytes !== undefined
      ? Math.max(0, Math.min(100, Math.round(this.status.receivedBytes / this.status.totalBytes * 100)))
      : null,
  )

  apply(status: VoiceModelStatus): void {
    this.status = status
  }

  async refresh(): Promise<void> {
    this.apply(await window.solus.voiceModelStatus())
  }

  async retry(): Promise<void> {
    this.apply(await window.solus.voiceModelRetry())
  }
}

export function formatVoiceModelBytes(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${Math.round(bytes / 1024 / 1024)} MB`
}

export const [getVoiceModelStore, setVoiceModelStore] = createContext<VoiceModelStore>()

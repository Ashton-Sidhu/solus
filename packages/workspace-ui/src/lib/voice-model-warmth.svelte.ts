import { serverConnections } from '@solus/client-core/server-connections'
import { VOICE_WARM_RENEW_MS } from '@solus/contracts/voice-stream'
import { hosts } from '../contexts/hosts/hosts.svelte'

/** One client-wide hold, independent of mounted composers and recording state. */
export function useVoiceModelWarmth(settings: { readonly voiceModeEnabled: boolean }): void {
  $effect(() => {
    if (!settings.voiceModeEnabled) return
    const host = hosts.transcription
    if (!host?.voiceReady || !host.capabilityRecord?.voiceStreaming) return
    const api = serverConnections.apiFor(host.id)
    let pending = false
    const renew = () => {
      if (pending) return
      pending = true
      void api.warmTranscription({ keepWarm: true }).catch(() => {}).finally(() => { pending = false })
    }
    renew()
    const timer = setInterval(renew, VOICE_WARM_RENEW_MS)
    return () => {
      clearInterval(timer)
      void api.warmTranscription({ keepWarm: false }).catch(() => {})
    }
  })
}

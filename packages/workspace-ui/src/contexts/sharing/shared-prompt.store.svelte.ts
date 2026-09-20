import { serverConnections } from '@solus/client-core/server-connections'

/** Retain the draft on refusal or an uncertain receipt. Never retry a prompt automatically. */
export class SharedPromptStore {
  available = $state(false)
  text = $state('')
  sending = $state(false)
  error = $state<string | null>(null)
  watch(serverId: string, sessionId: string): () => void {
    let stopped = false
    let reading = false
    const read = async () => {
      if (reading) return
      reading = true
      try {
        const available = await serverConnections.apiFor(serverId).sharedSessionAvailable(sessionId)
        if (!stopped) this.available = available
      } catch { if (!stopped) this.available = false }
      finally { reading = false }
    }
    void read()
    const timer = setInterval(() => { void read() }, 3_000)
    return () => { stopped = true; clearInterval(timer) }
  }
  async send(serverId: string, sessionId: string): Promise<void> {
    if (this.sending || !this.text.trim()) return
    this.sending = true
    this.error = null
    const text = this.text
    try {
      await serverConnections.apiFor(serverId).sharedSessionPrompt({ sessionId, text })
      if (this.text === text) this.text = ''
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'The runner did not confirm receipt.'
    } finally { this.sending = false }
  }
}

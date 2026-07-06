import type { DetectedEditor, DetectedTerminal } from '../../shared/types'

export class ToolsStore {
  detectedEditors = $state<DetectedEditor[]>([])
  detectedTerminals = $state<DetectedTerminal[]>([])
  detectedToolsLoaded = $state(false)
  detectedToolsLoading = $state(false)

  private detectedToolsInFlight: Promise<{ editors: DetectedEditor[]; terminals: DetectedTerminal[] }> | null = null

  async loadDetectedTools(opts: { force?: boolean } = {}): Promise<{ editors: DetectedEditor[]; terminals: DetectedTerminal[] }> {
    if (this.detectedToolsLoaded && !opts.force) {
      return { editors: this.detectedEditors, terminals: this.detectedTerminals }
    }
    if (this.detectedToolsInFlight && !opts.force) return this.detectedToolsInFlight

    this.detectedToolsLoading = true
    const promise = window.solus
      .detectEditors()
      .then((result) => {
        this.detectedEditors = result.editors
        this.detectedTerminals = result.terminals
        this.detectedToolsLoaded = true
        return result
      })
      .catch(() => {
        const empty = { editors: [] as DetectedEditor[], terminals: [] as DetectedTerminal[] }
        this.detectedEditors = empty.editors
        this.detectedTerminals = empty.terminals
        this.detectedToolsLoaded = true
        return empty
      })
      .finally(() => {
        this.detectedToolsLoading = false
        if (this.detectedToolsInFlight === promise) this.detectedToolsInFlight = null
      })
    this.detectedToolsInFlight = promise
    return promise
  }
}

export const toolsStore = new ToolsStore()

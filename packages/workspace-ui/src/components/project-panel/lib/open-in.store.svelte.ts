import { parseOpenInTarget, type OpenInTarget } from './open-in'

const STORAGE_KEY = 'solus:open-in'

class OpenInStore {
  chosen = $state<OpenInTarget | null>(null)

  constructor() {
    try { this.chosen = parseOpenInTarget(localStorage.getItem(STORAGE_KEY)) } catch {}
  }

  choose(target: OpenInTarget): void {
    this.chosen = target
    try { localStorage.setItem(STORAGE_KEY, target) } catch {}
  }
}

export const openInStore = new OpenInStore()

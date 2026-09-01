import type { BrowserLoadState } from '@solus/contracts/browser-types'
import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { NO_GUEST_CRASHES, planGuestRecovery, type GuestRecoveryState } from './guest-recovery'

/** The physical lifecycle of one desktop `<webview>` surface. */
export type NativeSurfacePhase =
  | 'absent'
  | 'mounting'
  | 'loading'
  | 'ready'
  | 'parked'
  | 'presented'
  | 'failed'

export interface NativeSurfaceRect {
  left: number
  top: number
  width: number
  height: number
  /** A maximized pane is fixed above the normal workspace. */
  layer: 'workspace' | 'maximized'
}

/** One stage's right to present a page's single native surface. */
export interface NativeSurfacePresentation {
  /** False once another stage has claimed this page. */
  present(rect: NativeSurfaceRect): boolean
  /** Keep the guest alive, but move it offscreen. */
  park(): void
  release(): void
}

/**
 * Owns the complete renderer-side lifecycle of native browser surfaces.
 *
 * The server owns durable browser-page state. This coordinator owns the
 * physical Electron guest: mounting, first load, presentation, parking, crash
 * replacement, and final removal. Pane components state intent through
 * `mount` and `claimPresentation`; they never use visibility as guest lifetime.
 */
export class NativeSurfaceCoordinator {
  /** Pages whose app-root webview must exist, including parked pages. */
  mountedKeys = new SvelteSet<string>()
  /** The one visible frame for each page. Absence means offscreen park. */
  rects = new SvelteMap<string, NativeSurfaceRect>()
  /** Observable lifecycle used for atomic picker-to-page handoff. */
  phases = new SvelteMap<string, NativeSurfacePhase>()

  #mountedKeys = new Set<string>()
  #publishedRects = new Map<string, NativeSurfaceRect>()
  #owners = new Map<string, symbol>()
  #painted = new Set<string>()
  #publishedPainted = new SvelteSet<string>()
  #phaseByKey = new Map<string, NativeSurfacePhase>()
  #publishedGenerations = new SvelteMap<string, number>()
  #generations = new Map<string, number>()
  #crashes = new Map<string, GuestRecoveryState>()
  #retries = new Map<string, ReturnType<typeof setTimeout>>()
  #remounting = new Set<string>()

  phaseOf(key: string): NativeSurfacePhase {
    return this.phases.get(key) ?? 'absent'
  }

  generationOf(key: string): number {
    return this.#publishedGenerations.get(key) ?? 0
  }

  hasPainted(key: string): boolean {
    return this.#publishedPainted.has(key)
  }

  /** Ensure a guest exists. Mounting does not make it visible. */
  mount(key: string): void {
    if (this.#mountedKeys.has(key)) return
    this.#mountedKeys.add(key)
    this.mountedKeys.add(key)
    this.#setPhase(key, 'mounting')
  }

  /** The Electron guest is attached and the host can begin its blank-first load. */
  attached(key: string): void {
    if (!this.#mountedKeys.has(key) || this.#painted.has(key)) return
    this.#setPhase(key, 'loading')
  }

  /** Fold Electron load reports into the physical surface lifecycle. */
  reported(key: string, loadState: BrowserLoadState): void {
    if (!this.#mountedKeys.has(key)) return
    if (loadState === 'ready') {
      this.#painted.add(key)
      this.#publishedPainted.add(key)
      this.#setPhase(key, this.#publishedRects.has(key) ? 'presented' : 'ready')
      return
    }
    if (loadState === 'failed') {
      this.#setPhase(key, 'failed')
      return
    }
    // Later navigation keeps the last painted page visible, like a browser.
    if (!this.#painted.has(key)) this.#setPhase(key, 'loading')
  }

  /** Claim where this page is shown. The newest visible stage wins. */
  claimPresentation(key: string): NativeSurfacePresentation {
    this.mount(key)
    const owner = Symbol(key)
    this.#owners.set(key, owner)
    return {
      present: (rect) => {
        if (this.#owners.get(key) !== owner) return false
        this.#present(key, rect)
        return true
      },
      park: () => {
        if (this.#owners.get(key) !== owner) return
        this.#park(key)
      },
      release: () => {
        if (this.#owners.get(key) !== owner) return
        this.#owners.delete(key)
        this.#park(key)
      },
    }
  }

  /** A guest died. Re-create it within the bounded recovery budget. */
  recoverAfterCrash(key: string, now: number): 'retrying' | 'exhausted' {
    const plan = planGuestRecovery(this.#crashes.get(key) ?? NO_GUEST_CRASHES, now)
    if (!plan) {
      this.#setPhase(key, 'failed')
      return 'exhausted'
    }
    this.#crashes.set(key, plan.state)
    this.#cancelRetry(key)
    this.#retries.set(key, setTimeout(() => {
      this.#retries.delete(key)
      this.#remount(key)
    }, plan.delayMs))
    return 'retrying'
  }

  /** Explicit user retry starts a fresh crash budget and a fresh guest. */
  reload(key: string): void {
    this.#crashes.delete(key)
    this.#remount(key)
  }

  /** A replacement teardown must not release the newly attached surface. */
  isReplacing(key: string): boolean {
    return this.#remounting.delete(key)
  }

  /** Close guests only when their server-authoritative pages are gone. */
  retain(keys: ReadonlySet<string>): void {
    for (const key of this.#mountedKeys) {
      if (keys.has(key)) continue
      this.close(key)
    }
  }

  close(key: string): void {
    this.#cancelRetry(key)
    this.#crashes.delete(key)
    this.#remounting.delete(key)
    this.#painted.delete(key)
    this.#publishedPainted.delete(key)
    this.#generations.delete(key)
    this.#publishedGenerations.delete(key)
    this.#mountedKeys.delete(key)
    this.mountedKeys.delete(key)
    this.#owners.delete(key)
    this.#clearRect(key)
    this.phases.delete(key)
    this.#phaseByKey.delete(key)
  }

  #present(key: string, rect: NativeSurfaceRect): void {
    const current = this.#publishedRects.get(key)
    if (
      current
      && current.left === rect.left
      && current.top === rect.top
      && current.width === rect.width
      && current.height === rect.height
      && current.layer === rect.layer
    ) return
    this.#publishedRects.set(key, rect)
    this.rects.set(key, rect)
    if (this.#painted.has(key)) this.#setPhase(key, 'presented')
  }

  #park(key: string): void {
    this.#clearRect(key)
    if (this.#painted.has(key)) this.#setPhase(key, 'parked')
  }

  #clearRect(key: string): void {
    this.#publishedRects.delete(key)
    this.rects.delete(key)
  }

  #remount(key: string): void {
    this.mount(key)
    const next = (this.#generations.get(key) ?? 0) + 1
    this.#remounting.add(key)
    this.#painted.delete(key)
    this.#publishedPainted.delete(key)
    this.#setPhase(key, 'mounting')
    this.#generations.set(key, next)
    this.#publishedGenerations.set(key, next)
  }

  #cancelRetry(key: string): void {
    const retry = this.#retries.get(key)
    if (retry === undefined) return
    clearTimeout(retry)
    this.#retries.delete(key)
  }

  #setPhase(key: string, phase: NativeSurfacePhase): void {
    // Commands run inside renderer effects. Their mutation path must never read
    // the reactive map it writes, or the effect subscribes to its own output.
    if (this.#phaseByKey.get(key) === phase) return
    this.#phaseByKey.set(key, phase)
    this.phases.set(key, phase)
  }
}

export const nativeSurfaces = new NativeSurfaceCoordinator()

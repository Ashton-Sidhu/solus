import { createAppContext } from './create-app-context'
import { MOBILE_QUERY } from './viewport'
import { localApi } from '@client-core/local-api'
import { serverConnections } from '@client-core/server-connections'

export type ViewMode = 'pill' | 'editor'

export class WindowContext {
  viewMode = $state<ViewMode>('pill')
  workAreaWidth = $state(0)
  workAreaHeight = $state(0)
  platform = $state<string>('unknown')
  visible = $state(true)

  get isMac(): boolean { return this.platform === 'darwin' }
  get isWindows(): boolean { return this.platform === 'win32' }
  get isLinux(): boolean { return this.platform === 'linux' }
  get isWeb(): boolean { return this.platform === 'web' }
  get isElectron(): boolean { return !this.isWeb && this.platform !== 'unknown' }

  constructor() {
    this.platform = localApi.getPlatform()
    this.viewMode = this.loadViewMode()
    // The editor overlays native traffic lights on renderer content. Publish
    // one document flag so its shared chrome geometry switches on together.
    if (this.isMac && this.viewMode === 'editor') {
      document.documentElement.classList.add('is-mac-editor')
    }
    this.workAreaWidth = window.innerWidth
    this.workAreaHeight = window.innerHeight
    // Coalesce the burst of resize events into one $state update per frame so
    // derived chains reading workAreaWidth/Height don't re-run on every tick.
    let raf = 0
    // Flag the document as actively resizing so expensive per-frame paint work
    // (notably backdrop-filter blur) can switch off for the duration of the
    // drag and back on shortly after it settles — the main cause of resize jank.
    let resizeIdle = 0
    const root = document.documentElement
    window.addEventListener('resize', () => {
      root.classList.add('solus-resizing')
      clearTimeout(resizeIdle)
      resizeIdle = window.setTimeout(() => root.classList.remove('solus-resizing'), 160)
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        this.workAreaWidth = window.innerWidth
        this.workAreaHeight = window.innerHeight
      })
    })
    window.solusNative?.onWindowShown(() => { this.visible = true })
    window.solusNative?.onWindowHidden(() => { this.visible = false })

    if (this.isWeb) {
      const mq = window.matchMedia(MOBILE_QUERY)
      mq.addEventListener('change', (e) => { this.viewMode = e.matches ? 'pill' : 'editor' })
    }
  }

  private loadViewMode(): ViewMode {
    if (this.isWeb) {
      return window.matchMedia(MOBILE_QUERY).matches ? 'pill' : 'editor'
    }
    // On Electron each window is mode-locked: main puts `?mode=` in the URL
    // and the mode never changes for the window's lifetime. Main persists the
    // last-used mode itself for the next boot.
    try {
      return new URLSearchParams(window.location.search).get('mode') === 'editor' ? 'editor' : 'pill'
    } catch {
      return 'pill'
    }
  }

  /** On Electron this doesn't change this window's mode — it asks main to
   *  surface the other mode's window (creating it on first use). */
  async setViewMode(mode: ViewMode): Promise<void> {
    if (this.isWeb) return
    await serverConnections.primaryApi().switchMode(mode)
  }
}

export const [getWindowContext, setWindowContext] = createAppContext<WindowContext>('window')

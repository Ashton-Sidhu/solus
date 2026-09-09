import { onDestroy } from 'svelte'
import type { IpcContext } from '@solus/contracts/types'
import { localApi } from '@solus/client-core/local-api'
import { serverConnections } from '@solus/client-core/server-connections'
import type { ClientSessionRef, ClientShellContext } from '@solus/workspace-ui/contexts/app/client-shell.svelte'
import { ClientViewport } from '@solus/workspace-ui/contexts/app/client-viewport.svelte'
import { runtime } from '@solus/workspace-ui/contexts/app/runtime.svelte'
import { writeSessionHandoff } from '@solus/workspace-ui/contexts/workspace/active-session-pointer'
import { track } from '@solus/workspace-ui/lib/analytics'

export type DesktopViewMode = 'pill' | 'editor'

/** Native mode is fixed for this window. A switch opens the other window. */
export class DesktopWindow extends ClientViewport implements ClientShellContext {
  readonly viewMode: DesktopViewMode = new URLSearchParams(window.location.search).get('mode') === 'editor'
    ? 'editor' : 'pill'
  readonly platform = localApi.getPlatform()
  visible = $state(true)
  conversationVisible = $state(false)
  readonly supportsLocalAttachments = true
  readonly supportsNativeSettings = true
  readonly hasInsetTitlebar = this.platform === 'darwin' && this.viewMode === 'editor'

  get isOverlayWindow(): boolean { return this.viewMode === 'pill' }
  get hasProjectPanel(): boolean { return this.viewMode === 'editor' }
  get hasCompanionPanes(): boolean { return this.viewMode === 'editor' }
  get groupsTabsByBranch(): boolean { return this.viewMode === 'editor' }
  get deferHistoryToolInputs(): boolean { return runtime.isMobileViewport }
  get rpcWindow(): IpcContext['window'] { return { viewMode: this.viewMode } }

  constructor() {
    super()
    if (this.hasInsetTitlebar) document.documentElement.classList.add('is-mac-editor')
    const shown = window.solusNative?.onWindowShown(() => { this.visible = true })
    const hidden = window.solusNative?.onWindowHidden(() => { this.visible = false })
    onDestroy(() => { shown?.(); hidden?.() })
  }

  async showWorkspace(): Promise<void> {
    if (this.viewMode === 'editor') return
    await serverConnections.localHostApi()?.switchMode('editor')
  }

  async continueInOtherWindow(session?: ClientSessionRef): Promise<void> {
    const target = this.viewMode === 'pill' ? 'editor' : 'pill'
    if (session) writeSessionHandoff({ ...session, target })
    track('mode_toggled', { mode: target })
    await serverConnections.localHostApi()?.switchMode(target)
  }
}

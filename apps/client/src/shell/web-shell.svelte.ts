import { onDestroy } from 'svelte'
import type { IpcContext } from '@solus/contracts/types'
import type { ClientShellContext } from '@solus/workspace-ui/contexts/app/client-shell.svelte'
import { ClientViewport } from '@solus/workspace-ui/contexts/app/client-viewport.svelte'
import { runtime } from '@solus/workspace-ui/contexts/app/runtime.svelte'

/** The browser selects its composition independently of native window modes. */
export class WebShell extends ClientViewport implements ClientShellContext {
  readonly supportsLocalAttachments = false
  readonly supportsNativeSettings = false
  readonly isOverlayWindow = false
  readonly groupsTabsByBranch = true
  readonly conversationVisible = true
  readonly hasInsetTitlebar = document.documentElement.classList.contains('solus-demo')
  visible = $state(document.visibilityState === 'visible')
  get layout(): 'mobile' | 'wide' { return runtime.isMobileViewport ? 'mobile' : 'wide' }
  get hasProjectPanel(): boolean { return this.layout === 'wide' }
  get hasCompanionPanes(): boolean { return this.layout === 'wide' }
  get deferHistoryToolInputs(): boolean { return this.layout === 'mobile' }
  // Retain the existing wire field until its consumers migrate. Layout and
  // component activation use the facts above, never this compatibility value.
  get rpcWindow(): IpcContext['window'] {
    return { viewMode: this.layout === 'mobile' ? 'pill' : 'editor' }
  }

  constructor() {
    super()
    const refreshVisibility = () => { this.visible = document.visibilityState === 'visible' }
    document.addEventListener('visibilitychange', refreshVisibility)
    onDestroy(() => document.removeEventListener('visibilitychange', refreshVisibility))
  }
}

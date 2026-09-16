import { onDestroy } from 'svelte'
import type { ClientShellContext } from '@solus/workspace-ui/contexts/app/client-shell.svelte'
import { ClientViewport } from '@solus/workspace-ui/contexts/app/client-viewport.svelte'
import { runtime } from '@solus/workspace-ui/contexts/app/runtime.svelte'

/** The browser selects its composition independently of native window modes. */
export class WebShell extends ClientViewport implements ClientShellContext {
  readonly supportsLocalAttachments = false
  readonly supportsNativeSettings = false
  readonly hasInsetTitlebar = document.documentElement.classList.contains('solus-demo')
  readonly hasWorkspace: boolean = true
  visible = $state(document.visibilityState === 'visible')
  get layout(): 'mobile' | 'wide' { return runtime.isMobileViewport ? 'mobile' : 'wide' }
  get hasProjectPanel(): boolean { return this.hasWorkspace && this.layout === 'wide' }
  get hasCompanionPanes(): boolean { return this.hasWorkspace && this.layout === 'wide' }
  get deferHistoryToolInputs(): boolean { return this.layout === 'mobile' }
  constructor() {
    super()
    const refreshVisibility = () => { this.visible = document.visibilityState === 'visible' }
    document.addEventListener('visibilitychange', refreshVisibility)
    onDestroy(() => document.removeEventListener('visibilitychange', refreshVisibility))
  }
}

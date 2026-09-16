import { onDestroy } from 'svelte'
import { localApi } from '@solus/client-core/local-api'
import type { ClientShellContext } from '@solus/workspace-ui/contexts/app/client-shell.svelte'
import { ClientViewport } from '@solus/workspace-ui/contexts/app/client-viewport.svelte'
import { runtime } from '@solus/workspace-ui/contexts/app/runtime.svelte'

/** Desktop facts for the single native workspace window. */
export class DesktopWindow extends ClientViewport implements ClientShellContext {
  readonly platform = localApi.getPlatform()
  visible = $state(true)
  readonly supportsLocalAttachments = true
  readonly supportsNativeSettings = true
  readonly hasInsetTitlebar = this.platform === 'darwin'
  readonly hasProjectPanel = true
  readonly hasCompanionPanes = true
  readonly hasWorkspace = true
  get deferHistoryToolInputs(): boolean { return runtime.isMobileViewport }

  constructor() {
    super()
    if (this.hasInsetTitlebar) document.documentElement.classList.add('is-mac-workspace')
    const shown = window.solusNative?.onWindowShown(() => { this.visible = true })
    const hidden = window.solusNative?.onWindowHidden(() => { this.visible = false })
    onDestroy(() => { shown?.(); hidden?.() })
  }
}

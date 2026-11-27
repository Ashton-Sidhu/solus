import { localApi } from '@solus/client-core/local-api'
import type { NativeSolusAPI } from '@solus/contracts/host-api'
import type { AppPermissionChange, AppPermissionsView } from '@solus/contracts/app-desktop'
import type { AppShortcutTarget } from '@solus/contracts/app-shortcuts'

type AppPermissionsApi = Pick<NativeSolusAPI, 'appPermissions' | 'setAppPermission' | 'forgetAppPermissions' | 'onAppPermissionsChanged'>

/**
 * The answers of this device for the desktop capabilities of each app
 * (docs/plans/app-desktop-capabilities.md §2). The desktop app's main process
 * owns them; this store mirrors its list for Settings and follows each change,
 * from Settings, from an app window's menu, or from a permission dialog. Web
 * and mobile have no app window: `isAvailable` is false there.
 */
export class AppPermissionsStore {
  apps = $state<AppPermissionsView[]>([])
  readonly isAvailable: boolean
  private hasStarted = false
  /** Only the newest read lands, so a slow read never puts back an older list. */
  private reads = 0

  constructor(private readonly api: Partial<AppPermissionsApi> = localApi) {
    this.isAvailable = api.appPermissions !== undefined
  }

  /** Reads the list once and follows its changes; safe to call from each surface that shows it. */
  start(): void {
    if (this.hasStarted || !this.isAvailable) return
    this.hasStarted = true
    this.api.onAppPermissionsChanged?.(() => void this.reload())
    void this.reload()
  }

  private async reload(): Promise<void> {
    const read = ++this.reads
    const apps = (await this.api.appPermissions?.()) ?? []
    if (read === this.reads) this.apps = apps
  }

  async change(change: AppPermissionChange): Promise<void> {
    await this.api.setAppPermission?.(change)
    await this.reload()
  }

  /** A deleted app keeps no answer on this device. */
  async forget(target: AppShortcutTarget): Promise<void> {
    await this.api.forgetAppPermissions?.(target)
    await this.reload()
  }
}

export const appPermissionsStore = new AppPermissionsStore()

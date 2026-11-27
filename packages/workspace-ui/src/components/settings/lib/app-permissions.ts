import {
  APP_DESKTOP_PERMISSIONS,
  appDesktopPermissionLabel,
  type AppDesktopPermission,
  type AppPermissionsView,
  type DesktopOs,
} from '@solus/contracts/app-desktop'

/** The answer a person picks for one permission in Settings. */
export type AppPermissionChoice = 'granted' | 'denied' | 'prompt'

export const APP_PERMISSION_CHOICES: ReadonlyArray<{ value: AppPermissionChoice; label: string }> = [
  { value: 'prompt', label: 'Ask' },
  { value: 'granted', label: 'Allow' },
  { value: 'denied', label: 'Don\'t allow' },
]

/** The operating system of this desktop client, for the names of the permissions. */
export function desktopOsOf(platform: string | undefined): DesktopOs {
  return platform === 'win32' || platform === 'linux' ? platform : 'darwin'
}

/** Each permission of one app, in the order of the menus, with its name and its answer. */
export function appPermissionRows(app: AppPermissionsView, os: DesktopOs): { permission: AppDesktopPermission; label: string; choice: AppPermissionChoice }[] {
  return APP_DESKTOP_PERMISSIONS.flatMap((permission) => {
    const state = app.permissions[permission]
    return state === 'unavailable' ? [] : [{ permission, label: appDesktopPermissionLabel(permission, os), choice: state }]
  })
}

/** One line under the app's name: what it may do now. */
export function appPermissionsSummary(app: AppPermissionsView, os: DesktopOs): string {
  const allowed = appPermissionRows(app, os).filter((row) => row.choice === 'granted').map((row) => row.label)
  return allowed.length === 0 ? 'Nothing allowed' : allowed.join(', ')
}

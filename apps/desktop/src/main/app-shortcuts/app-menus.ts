import type { MenuItemConstructorOptions } from 'electron'
import {
  APP_DESKTOP_PERMISSIONS,
  appDesktopPermissionLabel,
  type AppDesktopPermission,
  type AppDesktopPermissionState,
  type DesktopOs,
} from '@solus/contracts/app-desktop'

/** What the menus of one app show, and what their items do (docs/plans/app-desktop-capabilities.md §5). */
export interface AppMenuModel {
  os: DesktopOs
  name: string
  permissions: Record<AppDesktopPermission, AppDesktopPermissionState>
  /** The global shortcuts the app holds now, to list under Permissions. */
  shortcuts: readonly string[]
  hasMenuBarItem: boolean
  /** The app has a menu-bar page: a click on its item opens it in a popover. */
  hasPopover: boolean
  hasShortcut: boolean
  open(): void
  showPopover(): void
  reload(): void
  setGranted(permission: AppDesktopPermission, isGranted: boolean): void
  removeShortcut(): void
  quit(): void
}

function permissionItems(model: AppMenuModel): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = APP_DESKTOP_PERMISSIONS
    .filter((permission) => model.permissions[permission] !== 'unavailable')
    .map((permission) => {
      const isGranted = model.permissions[permission] === 'granted'
      return {
        label: appDesktopPermissionLabel(permission, model.os),
        type: 'checkbox',
        checked: isGranted,
        click: () => model.setGranted(permission, !isGranted),
      }
    })
  if (model.shortcuts.length === 0) return items
  return [
    ...items,
    { type: 'separator' },
    { label: 'Shortcuts in use', enabled: false },
    ...model.shortcuts.map((accelerator): MenuItemConstructorOptions => ({ label: accelerator, enabled: false })),
  ]
}

function removeMenuBarLabel(os: DesktopOs): string {
  return os === 'darwin' ? 'Remove from menu bar' : 'Remove from system tray'
}

/**
 * The menu of an app window: the macOS menu bar while the window has focus,
 * the window's own menu bar on Windows and Linux. macOS keeps the Solus menu
 * first, with its own Quit, and the Edit menu, so copy and paste work in the
 * app.
 */
export function appWindowMenuTemplate(model: AppMenuModel): MenuItemConstructorOptions[] {
  const appItems: MenuItemConstructorOptions[] = [
    { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: model.reload },
    { label: 'Permissions', submenu: permissionItems(model) },
  ]
  if (model.hasMenuBarItem) appItems.push({ label: removeMenuBarLabel(model.os), click: () => model.setGranted('menuBar', false) })
  if (model.hasShortcut) appItems.push({ type: 'separator' }, { label: `Remove ${model.name} shortcut…`, click: model.removeShortcut })
  appItems.push(
    { type: 'separator' },
    { label: 'Close Window', accelerator: 'CmdOrCtrl+W', role: 'close' },
    { label: `Quit ${model.name}`, click: model.quit },
  )
  const appMenu: MenuItemConstructorOptions = { label: model.name, submenu: appItems }
  if (model.os !== 'darwin') return [appMenu, { role: 'editMenu' }]
  return [{ role: 'appMenu' }, appMenu, { role: 'editMenu' }, { role: 'windowMenu' }]
}

/**
 * The menu of an app's menu-bar item. A Linux tray icon (StatusNotifierItem)
 * shows its menu on a click and gives no click to Solus, so on Linux the menu
 * opens the menu-bar page: what a click does on macOS and Windows.
 */
export function appTrayMenuTemplate(model: AppMenuModel): MenuItemConstructorOptions[] {
  const popover: MenuItemConstructorOptions[] = model.hasPopover && model.os === 'linux' ? [{ label: `Show ${model.name} Popover`, click: model.showPopover }] : []
  return [
    ...popover,
    { label: `Open ${model.name}`, click: model.open },
    { label: 'Reload', click: model.reload },
    { label: 'Permissions', submenu: permissionItems(model) },
    { label: removeMenuBarLabel(model.os), click: () => model.setGranted('menuBar', false) },
    { type: 'separator' },
    { label: `Quit ${model.name}`, click: model.quit },
  ]
}

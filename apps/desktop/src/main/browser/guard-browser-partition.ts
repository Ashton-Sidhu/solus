import { BrowserWindow, dialog, session, systemPreferences, type WebContents } from 'electron'
import { createLogger } from '@solus/server/logger'
import { guardBrowserSession, isBrowserPartition, type AskBrowserPermission, type BrowserMediaDevice, type BrowserSystemMediaAccess } from './browser-permissions'

const log = createLogger('browser', 'guard-browser-partition.ts')
const platform = process.platform

/**
 * Gives a browser partition its permission handlers before a page loads in it.
 * Call it wherever a guest is created with a partition: the `<webview>` the
 * renderer attaches and the hidden window of a headless page. Other partitions
 * are left alone.
 */
export function guardBrowserPartition(partition: string | undefined): void {
  if (!isBrowserPartition(partition)) return
  guardBrowserSession(session.fromPartition(partition), askInOwningWindow, systemMedia)
}

/** A `<webview>` guest asks over the workspace window that shows it. A headless
 *  page has no visible window and nobody to ask, so it gets no answer. */
const askInOwningWindow: AskBrowserPermission = async (requester, prompt, signal) => {
  const window = visibleOwningWindow(requester)
  if (!window) return undefined
  try {
    const { response } = await dialog.showMessageBox(window, {
      type: 'question',
      message: prompt.message,
      detail: prompt.detail,
      buttons: [...prompt.buttons],
      defaultId: 1,
      cancelId: 1,
      signal,
    })
    return response === 0
  } catch (err) {
    log.warn('browser_permission_prompt_failed', { error: err instanceof Error ? err.message : String(err) })
    return undefined
  }
}

function visibleOwningWindow(requester: WebContents): BrowserWindow | undefined {
  if (requester.isDestroyed()) return undefined
  const window = BrowserWindow.fromWebContents(requester.hostWebContents ?? requester)
  return window && !window.isDestroyed() && window.isVisible() ? window : undefined
}

const systemMedia: BrowserSystemMediaAccess | undefined =
  platform === 'darwin' || platform === 'win32' ? {
    hasAccess: hasSystemMediaAccess,
    async requestAccess(requester, devices, signal) {
      const needsAccess = devices.filter((device) => !hasSystemMediaAccess(device))
      if (!needsAccess.length) return true
      const window = visibleOwningWindow(requester)
      if (!window || signal.aborted) return false
      const canAsk = platform === 'darwin' && needsAccess.every(
        (device) => systemPreferences.getMediaAccessStatus(device) === 'not-determined',
      )
      if (canAsk) {
        for (const device of needsAccess) {
          if (signal.aborted) return false
          // Another partition can receive a system grant while this one waits.
          if (!hasSystemMediaAccess(device) && !await systemPreferences.askForMediaAccess(device)) return false
        }
        return devices.every(hasSystemMediaAccess)
      }
      const settings = platform === 'darwin' ? 'System Settings > Privacy & Security' : 'Settings > Privacy & security'
      await dialog.showMessageBox(window, {
        type: 'info',
        message: `Solus needs system access to your ${needsAccess.join(' and ')}.`,
        detail: `Check the device permissions in ${settings}, then reopen Solus.`,
        buttons: ['OK'],
        signal,
      })
      return false
    },
  } : undefined

function hasSystemMediaAccess(device: BrowserMediaDevice): boolean {
  const status = systemPreferences.getMediaAccessStatus(device)
  return platform === 'darwin' ? status === 'granted' : status !== 'denied' && status !== 'restricted'
}

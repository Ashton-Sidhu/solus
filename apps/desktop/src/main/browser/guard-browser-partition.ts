import { BrowserWindow, dialog, session, type WebContents } from 'electron'
import { createLogger } from '@solus/server/logger'
import { guardBrowserSession, isBrowserPartition, type BrowserPermissionPrompt } from './browser-permissions'

const log = createLogger('browser', 'guard-browser-partition.ts')

/**
 * Gives a browser partition its permission handlers before a page loads in it.
 * Call it wherever a guest is created with a partition: the `<webview>` the
 * renderer attaches and the hidden window of a headless page. Other partitions
 * are left alone.
 */
export function guardBrowserPartition(partition: string | undefined): void {
  if (!isBrowserPartition(partition)) return
  guardBrowserSession(session.fromPartition(partition), askInOwningWindow)
}

/** A `<webview>` guest asks over the workspace window that shows it. A headless
 *  page has no visible window and nobody to ask, so it gets no answer. */
async function askInOwningWindow(requester: WebContents, prompt: BrowserPermissionPrompt): Promise<boolean | undefined> {
  const window = BrowserWindow.fromWebContents(requester.hostWebContents ?? requester)
  if (!window || window.isDestroyed() || !window.isVisible()) return undefined
  try {
    const { response } = await dialog.showMessageBox(window, {
      type: 'question',
      message: prompt.message,
      detail: prompt.detail,
      buttons: [...prompt.buttons],
      defaultId: 1,
      cancelId: 1,
    })
    return response === 0
  } catch (err) {
    log.warn('browser_permission_prompt_failed', { error: err instanceof Error ? err.message : String(err) })
    return undefined
  }
}

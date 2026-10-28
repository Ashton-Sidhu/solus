import type { Session, WebContents } from 'electron'
import { BROWSER_PARTITION_PREFIX, BROWSER_UNSAVED_PARTITION_PREFIX } from '@solus/contracts/browser-types'

/**
 * What a page in the browser pane may use.
 *
 * Electron grants every permission when a session has no handler, so without
 * this any site the user opens could read the clipboard, the camera, the
 * microphone, or the location, with no prompt. Every browser partition gets
 * the handlers below; the app's own renderer (the default session) does not
 * (mac-permissions.ts owns it).
 *
 * | Permission                                   | Decision                           |
 * | -------------------------------------------- | ---------------------------------- |
 * | `clipboard-sanitized-write`                  | allow: a page's own "Copy" button  |
 * | `fullscreen`                                 | allow: confined to the guest, see  |
 * |                                              | `disableHtmlFullscreenWindowResize`|
 * | `pointerLock`                                | allow: canvas and game pages; Esc  |
 * |                                              | gives the pointer back             |
 * | `storage-access`, `top-level-storage-access` | allow: an embedded login reads its |
 * |                                              | own cookies in the same jar        |
 * | `clipboard-read`                             | ask once per origin, remembered    |
 * |                                              | for this app run                   |
 * | `openExternal`                               | ask every time: it opens another   |
 * |                                              | application                        |
 * | everything else (media, geolocation,         | deny                               |
 * | notifications, midi, display-capture, ...)   |                                    |
 *
 * Media and geolocation are denied, not asked: a grant would be Solus's own
 * macOS camera, microphone, or location access, and a page in a QA pane rarely
 * needs them. Notifications would appear as Solus's own.
 */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-sanitized-write',
  'fullscreen',
  'pointerLock',
  'storage-access',
  'top-level-storage-access',
])

const MAX_PROMPT_TEXT_LENGTH = 300

export interface BrowserPermissionPrompt {
  message: string
  detail?: string
  /** Allow, then deny. Deny is the default, so an Enter typed into the page
   *  cannot accept a prompt the page raised. */
  buttons: readonly [allow: string, deny: string]
}

/**
 * Shows one prompt over the window that shows `requester`. Resolves `true` for
 * allow, `false` for deny, and `undefined` when nobody answered: no visible
 * window, or the dialog failed.
 */
export type AskBrowserPermission = (requester: WebContents, prompt: BrowserPermissionPrompt) => Promise<boolean | undefined>

type RequestHandler = Parameters<Session['setPermissionRequestHandler']>[0] & {}
type CheckHandler = Parameters<Session['setPermissionCheckHandler']>[0] & {}
export interface BrowserPermissionHandlers {
  request: RequestHandler
  check: CheckHandler
}

type PermissionSession = Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>

export function isBrowserPartition(partition: string | undefined): partition is string {
  return !!partition
    && (partition.startsWith(BROWSER_PARTITION_PREFIX) || partition.startsWith(BROWSER_UNSAVED_PARTITION_PREFIX))
}

/** The handlers for one partition. Clipboard answers are kept per origin in
 *  memory only, so they last for the app run and for this partition alone. */
export function browserPermissionHandlers(ask: AskBrowserPermission): BrowserPermissionHandlers {
  const clipboardReadAnswers = new Map<string, boolean>()
  // One prompt at a time, so a page cannot stack dialogs by asking in a loop.
  let isPromptOpen = false

  const prompt = (requester: WebContents, content: BrowserPermissionPrompt, settle: (answer: boolean | undefined) => void): void => {
    if (isPromptOpen) {
      settle(undefined)
      return
    }
    isPromptOpen = true
    ask(requester, content).then(
      (answer) => {
        isPromptOpen = false
        settle(answer)
      },
      () => {
        isPromptOpen = false
        settle(undefined)
      },
    )
  }

  const request: RequestHandler = (webContents, permission, callback, details) => {
    if (permission === 'clipboard-read') {
      const origin = originOf(details.requestingUrl)
      if (origin === null) return callback(false)
      const remembered = clipboardReadAnswers.get(origin)
      if (remembered !== undefined) return callback(remembered)
      prompt(webContents, {
        message: `${truncate(origin)} wants to see text and images copied to the clipboard`,
        buttons: ['Allow', 'Block'],
      }, (answer) => {
        if (answer !== undefined) clipboardReadAnswers.set(origin, answer)
        callback(answer === true)
      })
      return
    }
    if (permission === 'openExternal') {
      const url = 'externalURL' in details ? details.externalURL : undefined
      const scheme = url ? schemeOf(url) : null
      if (!url || !scheme) return callback(false)
      prompt(webContents, {
        message: `Open this ${scheme} link?`,
        detail: `A page in the browser wants to open another application:\n\n${truncate(url)}`,
        buttons: ['Open', 'Cancel'],
      }, (answer) => callback(answer === true))
      return
    }
    callback(ALLOWED_PERMISSIONS.has(permission))
  }

  const check: CheckHandler = (_webContents, permission, requestingOrigin) => {
    if (permission === 'clipboard-read') {
      const origin = originOf(requestingOrigin)
      return origin !== null && clipboardReadAnswers.get(origin) === true
    }
    return ALLOWED_PERMISSIONS.has(permission)
  }

  return { request, check }
}

const guardedSessions = new WeakSet<PermissionSession>()

/** Installs the handlers once per session; a partition's session is shared by
 *  every page mounted in it. */
export function guardBrowserSession(session: PermissionSession, ask: AskBrowserPermission): void {
  if (guardedSessions.has(session)) return
  guardedSessions.add(session)
  const handlers = browserPermissionHandlers(ask)
  session.setPermissionRequestHandler(handlers.request)
  session.setPermissionCheckHandler(handlers.check)
}

function originOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    const { origin } = new URL(url)
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

function schemeOf(url: string): string | null {
  try {
    return new URL(url).protocol.slice(0, -1) || null
  } catch {
    return null
  }
}

function truncate(text: string): string {
  return text.length > MAX_PROMPT_TEXT_LENGTH ? `${text.slice(0, MAX_PROMPT_TEXT_LENGTH)}…` : text
}

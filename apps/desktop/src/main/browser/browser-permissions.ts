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
 * | `media`                                      | ask per origin and capture device  |
 * |                                              | in a native browser pane          |
 * | `openExternal`                               | ask every time: it opens another   |
 * |                                              | application                        |
 * | everything else (geolocation,                | deny                               |
 * | notifications, midi, display-capture, ...)   |                                    |
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
export type AskBrowserPermission = (requester: WebContents, prompt: BrowserPermissionPrompt, signal?: AbortSignal) => Promise<boolean | undefined>

export type BrowserMediaDevice = 'camera' | 'microphone'
export interface BrowserSystemMediaAccess {
  hasAccess(device: BrowserMediaDevice): boolean
  requestAccess(requester: WebContents, devices: readonly BrowserMediaDevice[], signal: AbortSignal): Promise<boolean>
}

type RequestHandler = Parameters<Session['setPermissionRequestHandler']>[0] & {}
type CheckHandler = Parameters<Session['setPermissionCheckHandler']>[0] & {}
export interface BrowserPermissionHandlers {
  request: RequestHandler
  check: CheckHandler
  revokeMedia(): void
}

type PermissionSession = Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>

export function isBrowserPartition(partition: string | undefined): partition is string {
  return !!partition
    && (partition.startsWith(BROWSER_PARTITION_PREFIX) || partition.startsWith(BROWSER_UNSAVED_PARTITION_PREFIX))
}

/** One partition's consent for this app run. */
export function browserPermissionHandlers(ask: AskBrowserPermission, systemMedia?: BrowserSystemMediaAccess): BrowserPermissionHandlers {
  const clipboardReadAnswers = new Map<string, boolean>()
  const mediaAnswers = { camera: new Map<string, boolean>(), microphone: new Map<string, boolean>() }
  let pendingMedia: AbortController | undefined
  // One prompt at a time, so a page cannot stack dialogs by asking in a loop.
  let isPromptOpen = false

  const prompt = async (requester: WebContents, content: BrowserPermissionPrompt, signal?: AbortSignal): Promise<boolean | undefined> => {
    if (isPromptOpen) return undefined
    isPromptOpen = true
    try {
      return await ask(requester, content, signal)
    } catch {
      return undefined
    } finally {
      isPromptOpen = false
    }
  }

  const requestMedia = async (requester: WebContents, details: Parameters<RequestHandler>[3]): Promise<boolean> => {
    if (!isNativeBrowserGuest(requester) || pendingMedia) return false
    const origin = mediaOrigin(('securityOrigin' in details ? details.securityOrigin : undefined) ?? details.requestingUrl)
    // Electron 44 reports screen and tab capture here with an empty list.
    const devices = new Set(('mediaTypes' in details ? details.mediaTypes : [])?.map(mediaDevice))
    if (!origin || !devices.size || devices.has(null)) return false
    const requested = [...devices].filter((device) => device !== null)
    if (requested.some((device) => mediaAnswers[device].get(origin) === false)) return false
    const undecided = requested.filter((device) => !mediaAnswers[device].has(origin))

    const decision = new AbortController()
    pendingMedia = decision
    const abandon = () => decision.abort()
    const onNavigation = (event: Electron.WebContentsDidStartNavigationEventParams) => {
      if (!event.isSameDocument && (event.isMainFrame || !details.isMainFrame)) abandon()
    }
    requester.on('did-start-navigation', onNavigation)
    requester.once('destroyed', abandon)
    requester.once('render-process-gone', abandon)
    try {
      if (undecided.length) {
        const label = requested.length === 2 ? 'camera and microphone' : requested[0]
        const answer = await prompt(requester, {
          message: `${truncate(origin)} wants to use your ${label}`,
          buttons: ['Allow', 'Block'],
        }, decision.signal)
        if (decision.signal.aborted || answer === undefined) return false
        if (!answer) {
          for (const device of undecided) mediaAnswers[device].set(origin, false)
          return false
        }
      }

      const hasAccess = !systemMedia || await systemMedia.requestAccess(requester, requested, decision.signal)
      if (decision.signal.aborted) return false
      for (const device of undecided) mediaAnswers[device].set(origin, true)
      return hasAccess
    } finally {
      pendingMedia = undefined
      requester.off('did-start-navigation', onNavigation)
      requester.off('destroyed', abandon)
      requester.off('render-process-gone', abandon)
    }
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
      }).then((answer) => {
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
      }).then((answer) => callback(answer === true))
      return
    }
    if (permission === 'media') {
      void requestMedia(webContents, details).then(callback, () => callback(false))
      return
    }
    callback(ALLOWED_PERMISSIONS.has(permission))
  }

  const check: CheckHandler = (webContents, permission, requestingOrigin, details) => {
    if (permission === 'clipboard-read') {
      const origin = originOf(requestingOrigin)
      return origin !== null && clipboardReadAnswers.get(origin) === true
    }
    if (permission === 'media') {
      const origin = mediaOrigin(details.securityOrigin ?? requestingOrigin)
      const device = mediaDevice(details.mediaType)
      return isNativeBrowserGuest(webContents) && origin !== null && device !== null
        && mediaAnswers[device].get(origin) === true && (systemMedia?.hasAccess(device) ?? true)
    }
    return ALLOWED_PERMISSIONS.has(permission)
  }

  return {
    request,
    check,
    revokeMedia() {
      mediaAnswers.camera.clear()
      mediaAnswers.microphone.clear()
      pendingMedia?.abort()
    },
  }
}

const guardedSessions = new WeakMap<PermissionSession, BrowserPermissionHandlers>()

/** Installs the handlers once per session; a partition's session is shared by
 *  every page mounted in it. */
export function guardBrowserSession(session: PermissionSession, ask: AskBrowserPermission, systemMedia?: BrowserSystemMediaAccess): void {
  if (guardedSessions.has(session)) return
  const handlers = browserPermissionHandlers(ask, systemMedia)
  session.setPermissionRequestHandler(handlers.request)
  session.setPermissionCheckHandler(handlers.check)
  guardedSessions.set(session, handlers)
}

export function revokeBrowserMediaPermissions(session: PermissionSession): void {
  guardedSessions.get(session)?.revokeMedia()
}

function isNativeBrowserGuest(requester: WebContents | null): boolean {
  return !!requester && !requester.isDestroyed() && requester.getType() === 'webview' && !!requester.hostWebContents
}

function mediaDevice(mediaType: string | undefined): BrowserMediaDevice | null {
  if (mediaType === 'video') return 'camera'
  if (mediaType === 'audio') return 'microphone'
  return null
}

function mediaOrigin(url: string | undefined): string | null {
  const origin = originOf(url)
  return origin && (origin.startsWith('https://') || origin.startsWith('http://')) ? origin : null
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

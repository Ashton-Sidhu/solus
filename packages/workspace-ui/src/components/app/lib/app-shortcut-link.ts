import { hostAddressOf, type AppShortcutTarget } from '@solus/contracts/app-shortcuts'
import { appShortcutLinkOf } from '@solus/contracts/app-shortcut-links'

/** The kind of device a browser runs on, for the shortcut link dialog (docs/app-shortcuts.md §6). */
export type ShortcutDevice = 'mac' | 'windows' | 'linux' | 'handheld' | 'other'

/** What the browser says of its device: `navigator.userAgent`, `navigator.platform`, and `navigator.maxTouchPoints`. */
export type BrowserAgent = Pick<Navigator, 'userAgent' | 'platform' | 'maxTouchPoints'>

/**
 * The device, as Executor's dashboard reads it: a phone or a tablet is
 * handheld, an iPad that asks for desktop sites too (it says Macintosh, and
 * has touch points). Solus for desktop runs on the three other kinds.
 */
export function shortcutDeviceOf(agent: BrowserAgent): ShortcutDevice {
  if (/\b(?:iPhone|iPad|iPod|Android)\b/.test(agent.userAgent)) return 'handheld'
  if (/\bMacintosh\b/.test(agent.userAgent) && agent.maxTouchPoints > 1) return 'handheld'
  const platform = agent.platform.toLowerCase()
  const userAgent = agent.userAgent.toLowerCase()
  if (platform.includes('win') || userAgent.includes('windows')) return 'windows'
  if (platform.includes('linux') || userAgent.includes('linux') || userAgent.includes('cros')) return 'linux'
  if (platform.includes('mac') || userAgent.includes('mac')) return 'mac'
  return 'other'
}

export type DesktopSystem = 'mac' | 'windows' | 'linux'

export interface DesktopDownload {
  system: DesktopSystem
  label: string
  url: string
}

/** The latest desktop build of each system, as solus.sh serves it (`apps/site/src/lib/download.ts`). */
export const DESKTOP_DOWNLOADS: readonly DesktopDownload[] = [
  { system: 'mac', label: 'Download for Mac (Apple silicon)', url: 'https://solus.sh/api/download' },
  { system: 'windows', label: 'Download for Windows (x64)', url: 'https://solus.sh/api/download?platform=windows' },
  { system: 'linux', label: 'Download for Linux (x64)', url: 'https://solus.sh/api/download?platform=linux' },
]

/**
 * The address that a shortcut link names for a host: the origin of the
 * route this page reaches it at, as `http:` or `https:`. Null for a route that
 * is not a plain address.
 */
export function linkAddressOf(routeUrl: string | null | undefined): string | null {
  if (!routeUrl) return null
  let url: URL
  try {
    url = new URL(routeUrl)
  } catch {
    return null
  }
  const protocol = url.protocol === 'ws:' ? 'http:' : url.protocol === 'wss:' ? 'https:' : url.protocol
  return hostAddressOf(`${protocol}//${url.host}`)
}

export interface AppShortcutLinkInput {
  target: AppShortcutTarget
  appName: string
  /** The URL this page dials the app's host at. */
  hostUrl: string | null
  /** The subject of the account that lists the host; null when the host is not on this page's account. */
  accountSubject: string | null
  device: ShortcutDevice
}

/** Why the link may not work, in the words the dialog shows. */
export type AppShortcutLinkNote =
  /** A phone or a tablet: Solus for desktop does not run there. */
  | 'handheld'
  /** A computer with another system: there is no Solus for desktop for it. */
  | 'other-system'
  /** The page has no address and no account to give: Solus there must already have the host. */
  | 'host-not-shared'

export interface AppShortcutLinkPlan {
  /** The `solus://app-shortcut/…` link; null where Solus for desktop cannot open it. */
  link: string | null
  /** The download for this computer first, then the others; none on a handheld device. */
  downloads: readonly DesktopDownload[]
  note: AppShortcutLinkNote | null
}

export function appShortcutLinkPlan(input: AppShortcutLinkInput): AppShortcutLinkPlan {
  if (input.device === 'handheld') return { link: null, downloads: [], note: 'handheld' }
  if (input.device === 'other') return { link: null, downloads: DESKTOP_DOWNLOADS, note: 'other-system' }
  const address = linkAddressOf(input.hostUrl)
  const link = appShortcutLinkOf({
    target: input.target,
    name: input.appName,
    offer: { address, account: input.accountSubject },
  })
  const device = input.device
  const downloads = [...DESKTOP_DOWNLOADS].sort((a, b) => Number(b.system === device) - Number(a.system === device))
  return { link, downloads, note: !address && !input.accountSubject ? 'host-not-shared' : null }
}

export const APP_SHORTCUT_LINK_NOTES = {
  handheld: 'App shortcuts are a feature of Solus for desktop, on a Mac, Windows, or Linux computer. Open this app in a browser there to add one.',
  'other-system': 'Solus for desktop runs on Mac, Windows, and Linux. There, this app can get an app shortcut.',
  'host-not-shared': 'This page reaches the host in a way that Solus for desktop cannot use. The link works when Solus on this computer already has this host.',
} satisfies Record<AppShortcutLinkNote, string>

import { describe, expect, test } from 'bun:test'
import { parseAppShortcutLink } from '@solus/contracts/app-shortcut-links'
import {
  appShortcutLinkPlan,
  linkAddressOf,
  shortcutDeviceOf,
} from '../../packages/workspace-ui/src/components/app/lib/app-shortcut-link'

// Add app shortcut on the web client (docs/app-shortcuts.md §5, §6): the link
// that Solus for desktop takes, the download for this computer, and what the
// dialog says where the link cannot work.

const notes = { host: '0123456789abcdef0123456789abcdef', appId: '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b' }
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const ANDROID = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36'

describe('the device of the browser', () => {
  // WHY: a phone or a tablet has no Solus for desktop, and an iPad that asks for desktop sites says it is a Mac.
  test('a phone or a tablet is handheld, an iPad that says Macintosh too; a computer is its system', () => {
    expect(shortcutDeviceOf({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 0 })).toBe('mac')
    expect(shortcutDeviceOf({ userAgent: MAC, platform: 'MacIntel', maxTouchPoints: 5 })).toBe('handheld')
    expect(shortcutDeviceOf({ userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5 })).toBe('handheld')
    expect(shortcutDeviceOf({ userAgent: ANDROID, platform: 'Linux armv8l', maxTouchPoints: 5 })).toBe('handheld')
    expect(shortcutDeviceOf({ userAgent: WINDOWS, platform: 'Win32', maxTouchPoints: 0 })).toBe('windows')
    expect(shortcutDeviceOf({ userAgent: LINUX, platform: 'Linux x86_64', maxTouchPoints: 0 })).toBe('linux')
    expect(shortcutDeviceOf({ userAgent: 'Mozilla/5.0 (PlayStation 5)', platform: '', maxTouchPoints: 0 })).toBe('other')
  })
})

describe('the plan of the dialog', () => {
  const input = {
    target: notes,
    appName: 'Notes',
    hostUrl: 'wss://studio.example.com/ws',
    accountSubject: 'user-a',
    device: 'windows' as const,
  }

  test("the link names the app, the origin of the page's route to the host, and the account that lists it", () => {
    const plan = appShortcutLinkPlan(input)
    expect(parseAppShortcutLink(plan.link ?? '')).toEqual({
      target: notes,
      name: 'Notes',
      offer: { address: 'https://studio.example.com', account: 'user-a' },
    })
    expect(plan.note).toBeNull()
  })

  // WHY: "Nothing opened?" must download the build for this computer, not the first one in a list.
  test('the download for this computer is first', () => {
    expect(appShortcutLinkPlan(input).downloads.map((download) => download.system)).toEqual(['windows', 'mac', 'linux'])
    expect(appShortcutLinkPlan({ ...input, device: 'linux' }).downloads[0]?.url).toBe('https://solus.sh/api/download?platform=linux')
  })

  // WHY: a link that cannot work must say so, not open nothing in silence.
  test('a phone gets one sentence, another system gets the downloads, and a host the page cannot share gets a note', () => {
    expect(appShortcutLinkPlan({ ...input, device: 'handheld' })).toEqual({ link: null, downloads: [], note: 'handheld' })
    const other = appShortcutLinkPlan({ ...input, device: 'other' })
    expect(other.link).toBeNull()
    expect(other.note).toBe('other-system')
    expect(other.downloads).toHaveLength(3)
    const unshared = appShortcutLinkPlan({ ...input, hostUrl: null, accountSubject: null })
    expect(unshared.link).toBe(`solus://app-shortcut/${notes.host}/${notes.appId}?name=Notes`)
    expect(unshared.note).toBe('host-not-shared')
  })

  test('only a plain http or https route gives an address', () => {
    expect(linkAddressOf('http://192.168.1.20:4317')).toBe('http://192.168.1.20:4317')
    expect(linkAddressOf('ws://127.0.0.1:4317/ws')).toBe('http://127.0.0.1:4317')
    expect(linkAddressOf('solus-local-video://x')).toBeNull()
    expect(linkAddressOf('not a url')).toBeNull()
    expect(linkAddressOf(null)).toBeNull()
  })
})

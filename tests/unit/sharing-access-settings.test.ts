import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseRef, serializeRef, type RouteRef } from '@solus/workspace-ui/contexts/workspace/routing/route-registry'
import { chosenSettingsHostId, settingsHostOrder } from '@solus/workspace-ui/components/settings/lib/settings-hosts'

// Settings → Sharing & access, as in T3 Code (plans/035 §0.4). What a person
// would notice going wrong: the page opens on a host they are not working on, a
// link to one host's page opens another, the host page or the host menu loses
// its way to the page, or the menu stops copying the MCP address.

// The palette's settings commands import page requests that hold `$state`.
;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value

const closedHostPages: string[] = []
mock.module('../../packages/workspace-ui/src/components/connections/connections-nav.svelte.ts', () => ({
  connectionsNav: { back: () => closedHostPages.push('back') },
}))
const { openSharingAccess, sharingAccessRoute } = await import('@solus/workspace-ui/components/connections/lib/sharing-access')
const { HOST_MENU_ACCESS_ITEMS } = await import('@solus/workspace-ui/components/fleet/lib/host-menu')
const { sharingAccessCommands } = await import('@solus/workspace-ui/components/settings/lib/settings-commands')

describe('the host picker', () => {
  const connected = ['first-to-answer', 'studio', 'this-mac']

  test('opens on the host of the current session, then on the host of this device', () => {
    expect(chosenSettingsHostId(settingsHostOrder(connected, ['studio', 'this-mac']), [])).toBe('studio')
    expect(chosenSettingsHostId(settingsHostOrder(connected, [undefined, 'this-mac']), [])).toBe('this-mac')
  })

  test('never opens on a host only because it answered first', () => {
    expect(settingsHostOrder(connected, ['studio', 'this-mac'])).toEqual(['studio', 'this-mac', 'first-to-answer'])
  })

  test('a lead host that is not connected is not listed', () => {
    expect(settingsHostOrder(connected, ['gone', 'this-mac'])).toEqual(['this-mac', 'first-to-answer', 'studio'])
  })

  test('the host a link names wins over the picked host, and an unknown one is passed over', () => {
    const order = settingsHostOrder(connected, ['studio', 'this-mac'])
    expect(chosenSettingsHostId(order, ['first-to-answer', 'this-mac'])).toBe('first-to-answer')
    expect(chosenSettingsHostId(order, ['gone', 'this-mac'])).toBe('this-mac')
    expect(chosenSettingsHostId([], ['studio'])).toBeNull()
  })
})

describe('the link to Sharing & access', () => {
  test('names its host, and the host survives the address bar', () => {
    const route = sharingAccessRoute('studio')
    expect(serializeRef(route)).toBe('settings/sharing/studio')
    expect(parseRef(serializeRef(route))).toEqual(route)
    expect(parseRef('settings/sharing')).toEqual({ name: 'settings', params: { tab: 'sharing' } })
  })

  test('a project scope carried over from another page is not read as a host', () => {
    // WHY: a tab change keeps `projectCwd`; read back as the host, it would open an unknown host.
    const carried: RouteRef = { name: 'settings', params: { tab: 'sharing', projectCwd: '/repo/app' } }
    expect(serializeRef(carried)).toBe('settings/sharing')
  })

  test('the Access tab and the host menu open the page for their host and close the host page', () => {
    const navigations: { ref: RouteRef; replace: boolean }[] = []
    closedHostPages.length = 0
    openSharingAccess({ navigate: (ref, opts) => navigations.push({ ref, replace: opts.replace }) }, 'studio')
    expect(navigations).toEqual([{ ref: sharingAccessRoute('studio'), replace: true }])
    expect(closedHostPages).toEqual(['back'])
  })

  test('the host page has no Access tab: its content is only on Sharing & access, and its Overview links there', () => {
    // WHY: T3 Code keeps sharing and access on one page; two copies of it drift apart.
    const hostDetail = readFileSync(join(import.meta.dir, '../../packages/workspace-ui/src/components/connections/HostDetail.svelte'), 'utf8')
    expect(hostDetail).not.toContain('value="access"')
    expect(hostDetail).not.toContain('HostDetailAccess')
    expect(hostDetail).toContain('next === "access" ? openSharingAccess(workspace.router, host.id)')
    const page = readFileSync(join(import.meta.dir, '../../packages/workspace-ui/src/components/connections/SharingAccessPage.svelte'), 'utf8')
    expect(page).toContain('<HostDetailAccess')
  })
})

describe('the host menu on Settings → Hosts', () => {
  test('copies the MCP address, and only while the host answers', () => {
    const copy = HOST_MENU_ACCESS_ITEMS.find((item) => item.action === 'copy-mcp-address')
    expect(copy?.label).toBe('Copy MCP address')
    expect(copy?.needsAnswer).toBe(true)
  })

  test('opens Sharing & access also for a host that does not answer, so its state shows', () => {
    const sharing = HOST_MENU_ACCESS_ITEMS.find((item) => item.action === 'sharing-access')
    expect(sharing?.label).toBe('Sharing & access')
    expect(sharing?.needsAnswer).toBe(false)
    expect(HOST_MENU_ACCESS_ITEMS.map((item) => item.action)).toEqual(['connect-apps', 'copy-mcp-address', 'sharing-access'])
  })
})

describe('the palette and the settings sidebar', () => {
  test('"Sharing & access" opens the page from the palette', () => {
    const opened: string[] = []
    const [command] = sharingAccessCommands({ showSettings: (tab, via) => opened.push(`${tab}:${via}`) })
    expect(command?.label).toBe('Sharing & access')
    void command?.run()
    expect(opened).toEqual(['sharing:palette'])
  })

  test('the page is in Connections, right after Hosts', () => {
    const page = readFileSync(join(import.meta.dir, '../../packages/workspace-ui/src/components/settings/SettingsPage.svelte'), 'utf8')
    const tabs = [...page.matchAll(/\{\s*id: "([^"]+)",[^}]*?group: "([^"]+)"/g)].map((match) => ({ id: match[1], group: match[2] }))
    const hosts = tabs.findIndex((tab) => tab.id === 'api-access')
    expect(tabs[hosts + 1]).toEqual({ id: 'sharing', group: 'Connections' })
  })
})

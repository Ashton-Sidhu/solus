import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'bun:test'
import type { RouteRef } from '@solus/workspace-ui/contexts/workspace/routing/route-registry'

const rendererRoot = join(import.meta.dir, '../../src/renderer')

function readRendererFile(path: string): string {
  return readFileSync(join(rendererRoot, path), 'utf8')
}

let RouterStore: typeof import('@solus/workspace-ui/contexts/workspace/routing/router.store.svelte').RouterStore

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value
  ;({ RouterStore } = await import('@solus/workspace-ui/contexts/workspace/routing/router.store.svelte'))
})

const TASKS: RouteRef = { name: 'tasks', params: {} }
const PRS: RouteRef = { name: 'prs', params: {} }

/** The five sidebar destinations that are routed pages. History is absent
 *  because it summons the picker overlay rather than navigating. */
const NAV_PAGES = ['folio', 'automations', 'insights', 'prs', 'tasks'] as const

describe('opening a page beside the conversation', () => {
  test('page exclusivity replaces a page where it already lives, ignoring the target', () => {
    // WHY: this is the trap the nav's "Open in split" has to work around. Pages
    // share one exclusive group, so asking for the companion while a page is
    // already leading replaces that page in the leading pane — the split the
    // user asked for never appears.
    const router = new RouterStore()
    router.navigate(TASKS)
    router.navigate(PRS, { target: 'aside' })

    expect(router.leadingPane.base?.name).toBe('prs')
    expect(router.asidePanes.length).toBe(0)
  })

  test('clearing the page group first is what puts the page in the companion pane', () => {
    // WHY: the conversation stays where the user left it and the page opens
    // beside it. That is the whole promise of "Open in split" from the nav.
    const router = new RouterStore()
    router.navigate(TASKS)
    router.closeGroup('page')
    router.navigate(PRS, { target: 'aside' })

    expect(router.leadingPane.base?.name).toBe('chat')
    expect(router.asidePanes[0]?.base?.name).toBe('prs')
  })

  test('showPage clears the group before honouring a companion target', () => {
    const context = readRendererFile('contexts/workspace/workspace.context.svelte.ts')
    expect(context).toContain("if (target === 'aside') this.router.closeGroup('page')")
  })
})

describe('sidebar navigation context menu', () => {
  test('every routed nav destination answers a right click', () => {
    // WHY: a menu on some nav rows and not others reads as a broken row. Every
    // destination that is a page must offer the same two ways in.
    const sidebar = readRendererFile('components/session/SessionSidebar.svelte')

    for (const page of NAV_PAGES) {
      expect(sidebar, page).toContain(`openNavContextMenu(event, "${page}")`)
    }
  })

  test('the menu opens the page in either pane, and left click keeps its toggle', () => {
    const sidebar = readRendererFile('components/session/SessionSidebar.svelte')

    expect(sidebar).toContain('onOpen={() => openNavPage(navPage, "focused")}')
    expect(sidebar).toContain('onOpenInSplit={() => openNavPage(navPage, "aside")}')
    // The nav's primary action is still a toggle; only the menu is additive.
    expect(sidebar).toContain('onclick={() => session.toggleTasks()}')

    const menu = readRendererFile('components/session/SidebarNavContextMenu.svelte')
    expect(menu).toContain('Open in split')
  })

  test('each nav page has a command that accepts the companion target', () => {
    // WHY: routing the menu through the page's own open command is what keeps
    // its side effects — the automations catalog load, the pull-request filter
    // reset — from being skipped when the page opens in the split.
    const context = readRendererFile('contexts/workspace/workspace.context.svelte.ts')

    for (const command of ['openFolio', 'openTasks', 'openPrs', 'openInsights', 'openAutomations']) {
      const signature = context.slice(context.indexOf(`  ${command}(`))
      expect(signature.slice(0, 240), command).toContain("target: 'focused' | 'aside' = 'focused'")
    }
  })
})

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserProfilePartition, type BrowserPage } from '@solus/contracts/browser-types'

/**
 * Clearing a browser profile on a standalone server.
 *
 * A Playwright profile is a user-data directory held open by a persistent
 * context, and the registry reloads every page on the profile after a clear so
 * the pane shows the signed-out state. Those two facts collide: closing the
 * context to delete the directory closes the pages under their drivers, and the
 * reload then runs against a detached session. These tests pin the rule that a
 * jar with live pages is emptied in place — what Electron's `clearStorageData`
 * does to a session it keeps alive.
 */

interface FakeCdpCall {
  method: string
  params: { origin?: string; storageTypes?: string } | undefined
}

class FakePage {
  closed = false
  reloads = 0
  async goto(_url: string): Promise<void> {}
  async goBack(): Promise<void> {}
  async goForward(): Promise<void> {}
  async reload(): Promise<void> {
    if (this.closed) throw new Error('Target page, context or browser has been closed')
    this.reloads += 1
  }
  url(): string {
    return 'http://localhost:5173/'
  }
  async title(): Promise<string> {
    return ''
  }
  async close(): Promise<void> {
    this.closed = true
  }
  isClosed(): boolean {
    return this.closed
  }
  on(): void {}
}

class FakeContext {
  closed = false
  cookieClears = 0
  readonly sessions: FakeCdpCall[][] = []
  private readonly open: FakePage[] = []

  constructor(readonly userDataDir: string) {}

  async newPage(): Promise<FakePage> {
    const page = new FakePage()
    this.open.push(page)
    return page
  }

  pages(): FakePage[] {
    return this.open.filter((page) => !page.closed)
  }

  async newCDPSession(_page: FakePage): Promise<{
    send(method: string, params?: FakeCdpCall['params']): Promise<Record<string, never>>
    on(): void
    off(): void
    detach(): Promise<void>
  }> {
    const calls: FakeCdpCall[] = []
    this.sessions.push(calls)
    return {
      send: async (method, params) => {
        if (this.closed) throw new Error('Target closed')
        calls.push({ method, params })
        return {}
      },
      on: () => {},
      off: () => {},
      detach: async () => {},
    }
  }

  async addCookies(): Promise<void> {}

  async clearCookies(): Promise<void> {
    this.cookieClears += 1
  }

  async close(): Promise<void> {
    this.closed = true
    for (const page of this.open) page.closed = true
  }
}

const contexts: FakeContext[] = []
mock.module('playwright-core', () => ({
  chromium: {
    launchPersistentContext: async (userDataDir: string) => {
      // Playwright creates the directory on launch; the profile is its contents.
      mkdirSync(userDataDir, { recursive: true })
      const context = new FakeContext(userDataDir)
      contexts.push(context)
      return context
    },
  },
}))

const dataDir = mkdtempSync(join(tmpdir(), 'solus-playwright-profiles-'))
const previousDataDir = process.env.SOLUS_DATA_DIR
const PROJECT = '/Users/dev/app'
const TARGET = { kind: 'url', url: 'http://localhost:5173/', projectRoot: PROJECT } as const

type HostModule = typeof import('@solus/server/browser/playwright-host')
type RegistryModule = typeof import('@solus/server/browser/browser-registry')
type SurfaceModule = typeof import('@solus/server/browser/surface-driver')

let host: HostModule
let registryModule: RegistryModule
let surface: SurfaceModule
let disposeHost: (() => Promise<void>) | null = null

beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = dataDir
  host = await import('@solus/server/browser/playwright-host')
  registryModule = await import('@solus/server/browser/browser-registry')
  surface = await import('@solus/server/browser/surface-driver')
})

afterEach(async () => {
  await disposeHost?.()
  disposeHost = null
  contexts.length = 0
  surface.setBrowserHeadlessHost(null)
  surface.setBrowserProfileHost(null)
})

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

async function harness() {
  disposeHost = await host.registerPlaywrightBrowserHost()
  if (!disposeHost) throw new Error('the fake playwright-core was not picked up')
  const published: BrowserPage[] = []
  const registry = registryModule.initBrowserRegistry({
    pageChanged: (page) => published.push(structuredClone(page)),
    pageClosed: () => {},
    surfaceRequested: () => {},
  })
  return { registry, published }
}

describe('clearing a profile on a Playwright host', () => {
  test('a jar with live pages is emptied in place, and the pages survive', async () => {
    // WHY: the registry reloads every page on the profile after the clear. If
    // the context were closed to delete the directory, that reload would run
    // against a dead session and the pane would keep showing the signed-in app
    // with a driver nothing can drive.
    const { registry } = await harness()
    const page = registry.open({ target: TARGET })
    await registry.navigate(page.browserPageId, { kind: 'reload' })
    const [context] = contexts
    if (!context) throw new Error('no context was launched')
    const [guest] = context.pages()
    if (!guest) throw new Error('no page was opened')
    const reloadsBefore = guest.reloads

    await registry.clearProfile(browserProfilePartition(PROJECT, 'default'))

    expect(context.closed).toBe(false)
    expect(guest.closed).toBe(false)
    expect(context.cookieClears).toBe(1)
    const cleared = context.sessions.flat().find((call) => call.method === 'Storage.clearDataForOrigin')
    expect(cleared?.params).toEqual({ origin: '*', storageTypes: 'all' })
    // The reload that shows the signed-out state actually happened.
    expect(guest.reloads).toBe(reloadsBefore + 1)
    expect(registry.get(page.browserPageId)?.hostKind).toBe('headless')
    expect(existsSync(context.userDataDir)).toBe(true)
  })

  test('a jar nothing is open on is deleted outright', async () => {
    // WHY: with no page to keep alive, the directory is the whole profile, and
    // the next guest on the partition should start from an empty one.
    const { registry } = await harness()
    const partition = browserProfilePartition(PROJECT, 'admin')
    const profileHost = surface.browserProfileHost()
    if (!profileHost) throw new Error('no profile host registered')
    // Importing opens the context without opening a page on it.
    await profileHost.importCookies(partition, [])
    const [context] = contexts
    if (!context) throw new Error('no context was launched')

    await registry.clearProfile(partition)

    expect(context.closed).toBe(true)
    expect(existsSync(context.userDataDir)).toBe(false)
  })

  test('a partition that could escape the profiles directory is refused', async () => {
    // WHY: the partition arrives from a client and becomes a path that is
    // deleted recursively.
    const { registry } = await harness()
    await expect(registry.clearProfile('persist:solus-browser/../../etc')).rejects.toThrow('Refusing')
    await expect(registry.clearProfile('persist:other')).rejects.toThrow('Refusing')
  })
})

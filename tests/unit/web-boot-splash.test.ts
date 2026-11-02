import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import type { Plugin, PluginOption } from 'vite'
import webConfig from '../../apps/client/vite.config'
import desktopConfig from '../../electron.vite.config'
import { BOOT_SPLASH_ID, BOOT_SPLASH_MARK, BOOT_SPLASH_MARKUP, BOOT_SPLASH_STYLE } from '@solus/workspace-ui/lib/boot-splash'
import { DEFERRED_STYLESHEET_ATTRIBUTE, stylesheetsApplied } from '../../apps/client/src/lib/page-styles'

// The Solus loading screen (docs/plans/fast-secure-startup.md, step 5): one splash,
// written into the HTML of the desktop renderer and of the web client, that paints
// before any code or stylesheet loads.

const repo = resolve(import.meta.dir, '../..')
const read = (path: string) => readFileSync(resolve(repo, path), 'utf8')

type HtmlHook = (html: string) => string
function htmlHook(plugins: PluginOption[] | undefined, name: string): HtmlHook | null {
  const plugin = (plugins ?? []).flat().find((each): each is Plugin => !!each && typeof each === 'object' && 'name' in each && each.name === name)
  if (!plugin) return null
  const hook = plugin.transformIndexHtml
  if (!hook || typeof hook !== 'object' || !('handler' in hook)) throw new Error(`${name} has no ordered HTML hook`)
  return (html) => (hook.handler as HtmlHook)(html)
}

const desktop = typeof desktopConfig === 'function' ? await desktopConfig({ command: 'build', mode: 'production' }) : desktopConfig
const desktopRenderer = desktop.renderer
if (!desktopRenderer || typeof desktopRenderer === 'function') throw new Error('The desktop renderer config must be an object')

const clients = {
  desktop: { html: read('apps/desktop/src/renderer/index.html'), plugins: desktopRenderer.plugins },
  web: { html: read('apps/client/index.html'), plugins: webConfig.plugins },
}

describe('one splash for desktop and web', () => {
  test('both pages get the same splash from the one source', () => {
    // WHY: the desktop and the web show one loading screen. A copy in either
    // index.html would drift from the other.
    const written: string[] = []
    for (const [client, { html, plugins }] of Object.entries(clients)) {
      expect({ client, ownCopy: html.includes(BOOT_SPLASH_ID) }).toEqual({ client, ownCopy: false })
      const splash = htmlHook(plugins, 'solus-boot-splash')
      if (!splash) throw new Error(`${client} does not write the boot splash`)
      const out = splash(html)
      expect(out).toContain(`<div id="root">${BOOT_SPLASH_MARKUP}</div>`)
      written.push(out.slice(out.indexOf(`<style>${BOOT_SPLASH_STYLE}</style>`), out.indexOf('</head>')))
      // The theme script still runs before the first paint: the splash reads `html.light`.
      expect(out.indexOf("classList.toggle('light'")).toBeLessThan(out.indexOf(BOOT_SPLASH_STYLE))
    }
    expect(written[0]).toBe(`<style>${BOOT_SPLASH_STYLE}</style>`)
    expect(written[1]).toBe(written[0])
  })

  test('the desktop boot failure draws the splash mark at the splash size', () => {
    // WHY: boot-scene.ts re-renders the splash with detail under it; a second mark
    // at another size would read as a new screen.
    const scene = read('apps/desktop/src/renderer/boot-scene.ts')
    expect(scene).toContain('${BOOT_SPLASH_MARK}')
    expect(scene).toContain('width: ${BOOT_SPLASH_MARK_SIZE}; height: ${BOOT_SPLASH_MARK_SIZE}')
    expect(BOOT_SPLASH_MARKUP).toContain(BOOT_SPLASH_MARK)
  })

  test('the mark breathes a few times and not at all under reduced motion', () => {
    // WHY: Solus has no perpetual animation, and it respects reduced motion.
    const animations = [...BOOT_SPLASH_STYLE.matchAll(/animation:([^;}]+)/g)].map((match) => ({ value: match[1]!, at: match.index! }))
    expect(animations).toHaveLength(1)
    const [animation] = animations
    expect(animation!.value).not.toContain('infinite')
    const iterations = animation!.value.split(/\s+/).map(Number).filter((each) => Number.isInteger(each))
    expect(iterations).toHaveLength(1)
    expect(iterations[0]!).toBeGreaterThan(0)
    expect(iterations[0]!).toBeLessThanOrEqual(6)
    const media = BOOT_SPLASH_STYLE.indexOf('@media (prefers-reduced-motion:no-preference){')
    expect(media).toBeGreaterThan(-1)
    expect(animation!.at).toBeGreaterThan(media)
    expect(animation!.at).toBeLessThan(BOOT_SPLASH_STYLE.indexOf('}}', media))
  })
})

describe('the web stylesheet does not hold the first paint', () => {
  const built = '<head><script type="module" crossorigin src="/assets/index.js"></script>'
    + '<link rel="stylesheet" crossorigin href="/assets/index.css">'
    + '<!--solus:workspace-preloads--><link rel="preload" as="style" fetchpriority="low" crossorigin href="/assets/App.css"><!--/solus:workspace-preloads--></head>'

  test('only the web links its stylesheet as a preload, with a fallback for no script', () => {
    // WHY: WebKit paints nothing until a render-blocking stylesheet arrives; the
    // desktop loads from disk and shows its window only after the app mounts.
    expect(htmlHook(clients.desktop.plugins, 'solus-non-blocking-stylesheets')).toBeNull()
    const deferred = htmlHook(clients.web.plugins, 'solus-non-blocking-stylesheets')
    if (!deferred) throw new Error('The web client must load its stylesheet without blocking')
    const out = deferred(built)
    const outsideNoscript = out.replace(/<noscript>[\s\S]*?<\/noscript>/g, '')
    expect(outsideNoscript).not.toContain('rel="stylesheet"')
    expect(out).toContain(`<link rel="preload" as="style" crossorigin href="/assets/index.css" ${DEFERRED_STYLESHEET_ATTRIBUTE} onload="this.onload=null;this.rel='stylesheet'">`)
    expect(out).toContain('<noscript><link rel="stylesheet" crossorigin href="/assets/index.css"></noscript>')
    // Solus Cloud drops this block on share links (docs/plans/instant-share-open.md).
    expect(out).toContain('<!--solus:workspace-preloads--><link rel="preload" as="style" fetchpriority="low" crossorigin href="/assets/App.css"><!--/solus:workspace-preloads-->')
  })

  test('the page is styled only when the preload has become an applied stylesheet', async () => {
    const onload = /onload="([^"]+)"/.exec(htmlHook(clients.web.plugins, 'solus-non-blocking-stylesheets')!(built))![1]!
    const link = Object.assign(new EventTarget(), { rel: 'preload', sheet: null as object | null, onload: null as (() => void) | null })
    link.onload = new Function(onload) as () => void
    link.addEventListener('load', () => link.onload?.call(link))
    let styled = false
    void stylesheetsApplied({ querySelectorAll: () => [link] } as never).then(() => { styled = true })
    const settle = async () => { for (let turn = 0; turn < 4; turn++) await Promise.resolve() }
    await settle()
    expect(styled).toBe(false)
    // The preload arrives: its own handler makes it a stylesheet, which still loads.
    link.dispatchEvent(new Event('load'))
    await settle()
    expect(link.rel).toBe('stylesheet')
    expect(styled).toBe(false)
    link.sheet = {}
    link.dispatchEvent(new Event('load'))
    await settle()
    expect(styled).toBe(true)
  })

  test('a stylesheet that fails to load does not keep the splash up', async () => {
    const link = Object.assign(new EventTarget(), { rel: 'preload', sheet: null })
    const applied = stylesheetsApplied({ querySelectorAll: () => [link] } as never)
    link.dispatchEvent(new Event('error'))
    await applied
  })
})

describe('the web entry script does not hold the first paint', () => {
  test('only the web loads its entry async, and the entry reads the page only after the parse', () => {
    // WHY: Safari painted a fresh login's splash only when the entry had loaded and
    // run (docs/benchmarks/fresh-login-profile-2026-11-01.json). With `async` the parse
    // ends, and the splash paints, while the entry still loads, so the entry must not
    // read `#root`, the shell's data blocks, or the stylesheet links before the parse ends.
    expect(htmlHook(clients.desktop.plugins, 'solus-async-entry-script')).toBeNull()
    const asyncEntry = htmlHook(clients.web.plugins, 'solus-async-entry-script')
    if (!asyncEntry) throw new Error('The web client must load its entry script async')
    expect(asyncEntry('<head><script type="module" crossorigin src="/assets/index.js"></script></head>'))
      .toBe('<head><script type="module" async crossorigin src="/assets/index.js"></script></head>')

    const path = 'apps/client/src/main.ts'
    const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
    const statements = source.statements.map((statement) => statement.getText(source))
    const parseWait = statements.findIndex((text) => text.includes("addEventListener('DOMContentLoaded'"))
    const firstPageRead = statements.findIndex((text) => !text.startsWith('import ') && /document\.(getElementById|querySelector)|\(document\)/.test(text))
    expect(parseWait).toBeGreaterThan(-1)
    expect(firstPageRead).toBeGreaterThan(parseWait)
  })
})

describe('every web surface waits for the stylesheet and takes the place of the splash', () => {
  const path = 'apps/client/src/main.ts'
  const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
  const transpiler = new Bun.Transpiler({ loader: 'ts' })
  // The surfaces' boot functions and the splash's own; the loaders and the rest are fakes.
  const names = new Set(['removeBootSplash', 'revealPage', 'connectToServer', 'bootHostlessHome', 'offerAppOrPair', 'bootGuest', 'startPage'])
  const declarations = source.statements.flatMap((statement) => ts.isFunctionDeclaration(statement) && names.has(statement.name?.text ?? '') ? [statement] : [])
  if (declarations.length !== names.size) throw new Error(`main.ts must declare ${[...names].join(', ')}`)
  const functions = declarations.map((statement) => transpiler.transformSync(statement.getText(source))).join('\n').replaceAll('import(', 'loadModule(')

  function boot(start: string, overrides: { loadWorkspaceApp?: () => Promise<never> } = {}) {
    const styles = Promise.withResolvers<void>()
    const splash = { isPresent: true, remove() { splash.isPresent = false } }
    const mounts: Array<{ surface: string; isSplashPresent: boolean }> = []
    const toasts = { dismiss() {}, error: mock(() => {}) }
    const dependencies = {
      BOOT_SPLASH_ID,
      document: { getElementById: (id: string) => (id === BOOT_SPLASH_ID && splash.isPresent ? splash : null) },
      mount: (surface: { name: string }) => { mounts.push({ surface: surface.name, isSplashPresent: splash.isPresent }); return {} },
      unmount() {},
      loadModule: async (specifier: string) => ({ default: { name: specifier.replace(/^.*\/|\.svelte$/g, '') } }),
      loadWorkspaceApp: async () => ({ default: { name: 'App' } }),
      loadGuestApp: async () => ({ default: { name: 'GuestApp' } }),
      toasts,
      isStaleBuildError: () => false,
      reportStaleBuild() {},
      serverConnections: { presenceOf: () => 'present', registerTarget() {}, setPrimary: () => ({ api: {} }), resolveId: (id: string) => id, ensure() {}, startCatalogSupervisors() {} },
      installWindowSolusApi() {},
      installServiceWorkerMessageBridge() {},
      prefetchStartupTranscript: async () => {},
      touchLastConnected() {},
      setActiveServerId() {},
      history: { replaceState() {} },
      location: { href: 'https://solus.example/w/abc', pathname: '/w/abc', hash: '' },
      matchMedia: () => ({ matches: true }),
      appPairLink: () => 'solus://pair',
      pairFromLocation() {},
      guestBoot: { fail() {} },
      loadGuestIdentity: () => null,
      connectGuest() {},
      webSession: null,
      pairTokenFromLocation: () => null,
      parseCloudShareLink: () => null,
      ...overrides,
    }
    const run = new Function('pageStyled', ...Object.keys(dependencies), `
      let solusApp = null;
      let connectionGeneration = 0;
      let pendingNotificationRoute = null;
      const root = {};
      ${functions}
      return ${start};
    `)
    const started = run(styles.promise, ...Object.values(dependencies))
    return { started, styles, splash, mounts, toasts }
  }

  const settle = async () => { for (let turn = 0; turn < 12; turn++) await Promise.resolve() }

  const surfaces = {
    workspace: { start: "connectToServer({ id: 'saved-host' })", surface: 'App' },
    'page with no host': { start: 'bootHostlessHome()', surface: 'HostlessHome' },
    'pairing on a phone': { start: "offerAppOrPair('pair-token')", surface: 'PairInApp' },
    'guest landing of a share link': { start: "bootGuest({}, { kind: 'failed', reason: 'gone' }, null)", surface: 'GuestLanding' },
    'incomplete share link': { start: 'startPage()', surface: 'GuestLanding' },
  }

  for (const [name, { start, surface }] of Object.entries(surfaces)) {
    test(`${name}: mounts only once the stylesheet applies, and removes the splash first`, async () => {
      // WHY: the stylesheet no longer holds the first paint, so a surface that mounts
      // before it paints with no styles; and the splash covers the whole window.
      const { styles, splash, mounts } = boot(start)
      await settle()
      expect(mounts).toEqual([])
      expect(splash.isPresent).toBe(true)
      styles.resolve()
      await settle()
      expect(mounts).toEqual([{ surface, isSplashPresent: false }])
    })
  }

  test('a workspace that fails to load removes the splash, so its toast shows', async () => {
    const { styles, splash, mounts, toasts } = boot("connectToServer({ id: 'saved-host' })", {
      loadWorkspaceApp: async () => { throw new Error('The workspace did not load') },
    })
    styles.resolve()
    await settle()
    expect(mounts).toEqual([])
    expect(toasts.error).toHaveBeenCalledWith('The workspace did not load')
    expect(splash.isPresent).toBe(false)
  })
})

import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderFirstScreen } from '../../scripts/vite-workspace-first-screen'

const clientRoot = resolve(import.meta.dir, '../../apps/client')
const packages = resolve(import.meta.dir, '../../packages')

describe('the web first screen in the HTML', () => {
  it('renders the sidebar frame and the draft composer with no browser', async () => {
    // WHY: the build writes this render into index.html so the page paints at HTML
    // arrival (docs/plans/fast-secure-startup.md, step 5). The build has no
    // document: a first-screen module that reads `window` or `document` when it
    // loads or renders breaks the build, so this render must run without them.
    for (const name of ['window', 'document', 'localStorage', 'matchMedia', 'location', 'history']) {
      expect(name in globalThis).toBe(false)
    }
    const { body, styles } = await renderFirstScreen({
      root: clientRoot,
      alias: {
        '@solus/workspace-ui': `${packages}/workspace-ui/src`,
        '@solus/contracts': `${packages}/contracts/src`,
        '@solus/client-core': `${packages}/client-core/src`,
      },
      component: '/src/shell/FirstScreen.svelte',
    })

    // The client finds the frame by this attribute to replace or remove it.
    expect(body).toContain('data-first-screen')
    // The session sidebar, while its rows load, with its collapse control.
    expect(body).toContain('aria-label="Loading sidebar"')
    expect(body).toContain('aria-label="Collapse sidebar"')
    // The draft: the headline and the prompt editor's plain stand-in, which takes typing at once.
    expect(body).toContain('<main')
    expect(body).toContain('What should we build?')
    expect(body).toMatch(/<textarea[^>]*aria-label="Plan, Build, Automate/)
    // The side panel's scoped styles come with the markup: the first paint has no workspace CSS.
    expect(styles).toContain('.side-panel-shell')
  }, 60_000)
})

describe('pages that are not the workspace', () => {
  const html = readFileSync(resolve(clientRoot, 'index.html'), 'utf8')
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]).find((each) => each.includes('solus-no-first-screen'))
  if (!script) throw new Error('index.html must hide the first screen on pages that are not the workspace')

  /** The classes the page's inline script puts on <html> at this path, before anything paints. */
  function rootClassesAt(pathname: string): string[] {
    const classes: string[] = []
    new Function('location', 'document', script)({ pathname }, { documentElement: { classList: { add: (name: string) => classes.push(name) } } })
    return classes
  }

  it('hides the frame before the first paint on share and pairing links', () => {
    // WHY: a share link's guest must never see a workspace that is not theirs, not
    // even for the moment before the page's code runs; the same HTML serves every path.
    for (const path of ['/w/abc', '/s/abc', '/t/abc', '/pair']) expect(rootClassesAt(path)).toEqual(['solus-no-first-screen'])
    expect(html).toContain('html.solus-no-first-screen [data-first-screen] { display: none; }')
  })

  it('shows the frame on workspace addresses', () => {
    for (const path of ['/', '/tasks', '/session/abc', '/settings/general', '/pairing', '/share']) expect(rootClassesAt(path)).toEqual([])
  })
})

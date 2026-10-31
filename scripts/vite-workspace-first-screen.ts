import type { AliasOptions, Plugin } from 'vite'
import { createServer, transformWithEsbuild } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

const ROOT_ELEMENT = '<div id="root"></div>'

/** The first screen as HTML: its markup and the scoped styles of its components. */
export interface FirstScreenHtml { body: string; styles: string }

/**
 * Renders a Svelte component with Svelte's server renderer, the way the
 * browser would draw it with no person's data: the build has no document,
 * no storage, and no host. Components in it must not reach for `window` or
 * `document` while their modules load or while they render.
 *
 * Each component's scoped styles come out as `<style>` elements, so the
 * first paint does not wait for the workspace's own CSS.
 */
export async function renderFirstScreen(options: { root: string; alias: AliasOptions; component: string }): Promise<FirstScreenHtml> {
  const server = await createServer({
    configFile: false,
    root: options.root,
    resolve: { alias: options.alias },
    plugins: [svelte({ compilerOptions: { css: 'injected', dev: false }, emitCss: false })],
    // Packages ship `.svelte` files (icons, primitives): Vite compiles them, not Node.
    ssr: { noExternal: true },
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, watch: null, ws: false },
    appType: 'custom',
    logLevel: 'error',
  })
  try {
    const [{ default: component }, { render }] = await Promise.all([
      server.ssrLoadModule(options.component),
      server.ssrLoadModule('svelte/server'),
    ])
    const { head, body } = render(component)
    // Svelte writes one `<style>` element for each component, with its source map.
    const css = [...head.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('\n')
    const { code } = await transformWithEsbuild(css, 'first-screen.css', { loader: 'css', minify: true, sourcemap: false })
    return { body, styles: code ? `<style>${code.trim()}</style>` : '' }
  } finally {
    await server.close()
  }
}

/**
 * Writes the empty workspace into the page's root element at build time
 * (docs/plans/fast-secure-startup.md, step 5), so the browser paints it when
 * the HTML arrives, before any of the workspace's code has loaded. The client
 * replaces it when the workspace mounts and removes it before it mounts any
 * other page (apps/client/src/lib/first-screen.ts).
 */
export function workspaceFirstScreen(component: string): Plugin {
  let root = ''
  let alias: AliasOptions = []
  return {
    name: 'solus-workspace-first-screen',
    apply: 'build',
    configResolved(config) {
      root = config.root
      alias = config.resolve.alias
    },
    transformIndexHtml: {
      // After Vite's own pass over the HTML: the markup and styles need none of it.
      order: 'post',
      async handler(html) {
        if (!html.includes(ROOT_ELEMENT)) throw new Error(`index.html has no empty ${ROOT_ELEMENT} for the first screen`)
        const { body, styles } = await renderFirstScreen({ root, alias, component })
        return html.replace('</head>', `${styles}</head>`).replace(ROOT_ELEMENT, `<div id="root">${body}</div>`)
      },
    },
  }
}

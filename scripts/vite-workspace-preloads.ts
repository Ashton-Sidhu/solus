import type { Plugin } from 'vite'

const WORKSPACE_PRELOADS_START = '<!--solus:workspace-preloads-->'
const WORKSPACE_PRELOADS_END = '<!--/solus:workspace-preloads-->'

/**
 * Lists the workspace's startup code in the HTML: the static import graph of
 * each module in `roots` (path suffixes of modules the entry imports
 * dynamically), and its CSS. Without the list, the browser fetches that code
 * only once the entry has run, and, where the build turns off Vite's runtime
 * preloads (the web client), finds it one import level at a time. Static links
 * cost nothing to insert, unlike the runtime preload loop
 * (docs/benchmarks/web-load-2026-10-30.json).
 *
 * The links ask for low priority (`fetchpriority="low"`): the entry script and the
 * page's first token request go first (docs/plans/fast-secure-startup.md, step 3).
 *
 * The markers let a server drop the block where a page opens no workspace: a
 * share link resolves before any app code loads (docs/plans/instant-share-open.md).
 */
export function workspaceStartupPreloads(roots: string[]): Plugin {
  let base = '/'
  return {
    name: 'solus-workspace-startup-preloads',
    apply: 'build',
    configResolved(config) {
      base = config.base
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, { bundle }) {
        if (!bundle) return html
        const chunks = Object.values(bundle).flatMap((output) => (output.type === 'chunk' ? [output] : []))
        const scripts = new Set<string>()
        const styles = new Set<string>()
        const visit = (fileName: string) => {
          if (scripts.has(fileName)) return
          scripts.add(fileName)
          const chunk = bundle[fileName]
          if (chunk?.type !== 'chunk') return
          for (const css of chunk.viteMetadata?.importedCss ?? []) styles.add(css)
          for (const imported of chunk.imports) visit(imported)
        }
        for (const root of roots) {
          const chunk = chunks.find((each) => each.isDynamicEntry && each.moduleIds.some((id) => id.endsWith(root)))
          if (!chunk) throw new Error(`The startup module ${root} is missing from the build`)
          visit(chunk.fileName)
        }
        const isUnlisted = (fileName: string) => !html.includes(`"${base}${fileName}"`)
        const links = [
          ...[...scripts].filter(isUnlisted).map((fileName) => `<link rel="modulepreload" fetchpriority="low" crossorigin href="${base}${fileName}">`),
          ...[...styles].filter(isUnlisted).map((fileName) => `<link rel="preload" as="style" fetchpriority="low" crossorigin href="${base}${fileName}">`),
        ]
        return html.replace('</head>', `${WORKSPACE_PRELOADS_START}${links.join('')}${WORKSPACE_PRELOADS_END}</head>`)
      },
    },
  }
}

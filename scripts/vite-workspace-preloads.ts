import type { Plugin } from 'vite'
import type { GetManualChunk } from 'rollup'

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

/**
 * Puts the workspace's own startup code in one chunk: every source module
 * that the modules in `roots` reach through static imports, less what the
 * entry itself reaches. The browser then opens the first screen with a few large files,
 * not about a hundred small ones, which WebKit pays for per request.
 *
 * Use it with `onlyExplicitManualChunks`, so Rollup moves no other module
 * into the chunk. The set is closed under static imports, and the entry's
 * graph is outside it: the entry reaches the chunk only through its dynamic
 * import, so no static cycle with the entry can form, and nothing that loads
 * later joins the startup files.
 */
export function workspaceStartupChunk(roots: string[]): GetManualChunk {
  let startup: Set<string> | null = null
  return (id, { getModuleIds, getModuleInfo }) => {
    if (!startup) {
      const closure = (from: string[]) => {
        const seen = new Set<string>()
        const queue = [...from]
        while (queue.length > 0) {
          const next = queue.pop()!
          if (seen.has(next)) continue
          seen.add(next)
          queue.push(...(getModuleInfo(next)?.importedIds ?? []))
        }
        return seen
      }
      const ids = [...getModuleIds()]
      const entryGraph = closure(ids.filter((each) => getModuleInfo(each)?.isEntry))
      const rootIds = roots.map((root) => {
        const match = ids.find((each) => each.endsWith(root))
        if (!match) throw new Error(`The startup module ${root} is missing from the build`)
        return match
      })
      // Only our own source. A package barrel (`bits-ui`) names every module of
      // the package, so a walk through it would claim modules that only later
      // surfaces use; Rollup resolves those through the bindings it uses. Our
      // modules declare no `sideEffects: false`, so Rollup keeps each one the
      // walk reaches, and the walk is exact for them. Package code keeps its
      // own chunks, and it never imports our modules, so no cycle forms.
      startup = new Set([...closure(rootIds)].filter((each) => !entryGraph.has(each) && !each.startsWith('\0') && !each.includes('/node_modules/')))
    }
    return startup.has(id) ? 'workspace' : null
  }
}

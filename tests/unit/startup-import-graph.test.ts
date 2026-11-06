import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/**
 * What a client loads before its workspace is usable: the entry, and every
 * module the entry reaches through static imports from the modules it awaits
 * before mount. A dynamic `import()` is a later chunk and ends the walk.
 *
 * An optional control that slips back into this graph through a second static
 * importer costs every launch — a chat-only start downloads and parses it
 * without ever showing it. That is the regression these assertions catch; a
 * module that has not changed its loading contract cannot fail them.
 */

const ROOT = resolve(import.meta.dir, '../..')
const ALIASES: Array<[string, string]> = [
  ['@solus/workspace-ui/', 'packages/workspace-ui/src/'],
  ['@solus/client-core/', 'packages/client-core/src/'],
  ['@solus/contracts/', 'packages/contracts/src/'],
  ['@solus/document-model/', 'packages/document-model/src/'],
]
const EXTENSIONS = ['', '.ts', '.svelte.ts', '.js', '/index.ts']
const transpiler = new Bun.Transpiler({ loader: 'ts', trimUnusedImports: false })

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile()
}

function resolveLocal(base: string): string | null {
  for (const extension of EXTENSIONS) {
    const candidate = base + extension
    if (isFile(candidate)) return candidate
    if (candidate.endsWith('.js') && isFile(candidate.slice(0, -3) + '.ts')) return candidate.slice(0, -3) + '.ts'
  }
  return null
}

/** A package name for a bare specifier, or a file for a local one. */
function resolveSpecifier(from: string, specifier: string): { file: string } | { packageName: string } | null {
  if (specifier.startsWith('.')) {
    const file = resolveLocal(resolve(dirname(from), specifier))
    return file ? { file } : null
  }
  for (const [alias, target] of ALIASES) {
    if (specifier.startsWith(alias)) {
      const file = resolveLocal(join(ROOT, target, specifier.slice(alias.length)))
      return file ? { file } : null
    }
  }
  const parts = specifier.split('/')
  return { packageName: specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] }
}

/** Script source of a module. Svelte markup `{#await import()}` is dynamic by
 *  construction, so only the `<script>` blocks can import statically. */
function scriptSource(file: string): string {
  const text = readFileSync(file, 'utf8')
  if (!file.endsWith('.svelte')) return text
  return [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((match) => match[1]).join('\n')
}

function staticGraph(roots: string[]): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>()
  const packages = new Set<string>()
  const queue = roots.map((root) => join(ROOT, root))
  while (queue.length > 0) {
    const file = queue.pop()!
    if (files.has(file)) continue
    files.add(file)
    if (!/\.(ts|js|svelte)$/.test(file)) continue
    for (const entry of transpiler.scanImports(scriptSource(file))) {
      if (entry.kind !== 'import-statement') continue
      const target = resolveSpecifier(file, entry.path)
      if (!target) continue
      if ('packageName' in target) packages.add(target.packageName)
      else queue.push(target.file)
    }
  }
  return { files, packages }
}

const CLIENTS = {
  web: ['apps/client/src/main.ts', 'apps/client/src/App.svelte'],
  desktop: [
    'apps/desktop/src/renderer/main.ts',
    'apps/desktop/src/renderer/App.svelte',
    'packages/workspace-ui/src/components/layout/WorkspaceLayout.svelte',
  ],
}

const DEFERRED_COMPONENTS = [
  'packages/workspace-ui/src/components/sharing/ShareDialog.svelte',
  'packages/workspace-ui/src/components/session/unified-picker/UnifiedPicker.svelte',
  'packages/workspace-ui/src/components/project-panel/ProjectPanel.svelte',
  'packages/workspace-ui/src/components/insights/lib/sql-format.ts',
  // The query store loads when a person asks Insights a question, not with the
  // workspace and menus that offer one.
  'packages/workspace-ui/src/components/insights/insights.store.svelte.ts',
  // A work's History brings the diff and Markdown renderers; it loads when opened.
  'packages/workspace-ui/src/components/work/WorkHistoryDialog.svelte',
  // Yjs, and Tiptap for a document, load with the first live work, not the workspace.
  'packages/workspace-ui/src/contexts/works/work-live-doc.svelte.ts',
  'packages/document-model/src/schema.ts',
  // Changed-file paths need only the patch splitter, not the diff metadata cache.
  'packages/workspace-ui/src/lib/pierre-diff/metadata.ts',
  // An artifact's frame, rail, and header actions load when an artifact opens; the
  // save picker when an export asks for a place (docs/benchmarks/web-load-2026-10-30.json).
  'packages/workspace-ui/src/components/artifact/ArtifactShell.svelte',
  'packages/workspace-ui/src/components/pickers/SaveFilePicker.svelte',
  // The Ed25519 verifier loads only to dial an `http:` route.
  'packages/contracts/src/host-proof.ts',
  // The palette's command lists load with the palette, after the first paint.
  'apps/client/src/lib/palette-commands.ts',
  'apps/desktop/src/renderer/shell/desktop-palette.svelte.ts',
  'packages/workspace-ui/src/components/servers/lib/add-wsl-distro-commands.ts',
  // Auto balance is off by default. It loads at its first check, and the Run on
  // row with it (docs/plans/resource-telemetry.md).
  'packages/workspace-ui/src/contexts/workspace/draft-balancer.ts',
  'packages/workspace-ui/src/components/servers/AutoBalanceRow.svelte',
  'packages/workspace-ui/src/components/servers/lib/run-on-balance.ts',
  'packages/client-core/src/host-balance.ts',
  // Stores the first screen does not use; the contexts barrel does not re-export them.
  'packages/workspace-ui/src/contexts/webhooks/webhooks.store.svelte.ts',
  'packages/workspace-ui/src/contexts/webhooks/webhook-admin.store.svelte.ts',
  // The prompt editor loads beside the workspace; a plain field holds the draft
  // until it runs (DeferredPromptEditor). This is CodeMirror and the menus.
  'packages/workspace-ui/src/components/ui/PromptEditor.svelte',
  'packages/workspace-ui/src/components/ui/plain-text-editor/plain-text-editor.svelte',
  'packages/workspace-ui/src/components/editor/autocomplete.svelte.ts',
  // Menus and dialogs load when they first open.
  'packages/workspace-ui/src/components/session/SessionContextMenu.svelte',
  'packages/workspace-ui/src/components/session/LinkSessionTaskDialog.svelte',
  'packages/workspace-ui/src/components/session/LinkPullRequestDialog.svelte',
  'packages/workspace-ui/src/components/servers/CopiedFilesDialog.svelte',
  'packages/workspace-ui/src/components/seats/SeatConnectPanel.svelte',
  // Surfaces the first screen does not show: a host to connect, a work, a
  // companion pane's strip, the page for a browser with no host.
  'packages/workspace-ui/src/components/session-draft/ConnectHostPage.svelte',
  'packages/workspace-ui/src/components/work/WorkPane.svelte',
  'packages/workspace-ui/src/components/layout/CompanionSurfaceStrip.svelte',
  'apps/client/src/routes/HostlessHome.svelte',
  // Devices load at their first event (device-feature.ts); the MCP sign-ins
  // after the first paint (app-core.ts). Both then follow every host.
  'packages/workspace-ui/src/contexts/devices/devices.store.svelte.ts',
  'packages/workspace-ui/src/components/devices/lib/device-entry.ts',
  'packages/workspace-ui/src/components/settings/integrations.store.svelte.ts',
  // The changed-file scan and the file icon set load beside the workspace.
  'packages/workspace-ui/src/lib/changedFiles.ts',
  'packages/client-core/src/file-icons.ts',
]

/** Packages that only later surfaces need. Each is tens of kilobytes or more. */
const DEFERRED_PACKAGES = [
  '@codemirror/view',
  '@codemirror/state',
  '@codemirror/commands',
  '@codemirror/language',
  '@codemirror/lang-markdown',
  '@lezer/markdown',
  '@pierre/trees',
  'croner',
  'yjs',
  '@tiptap/core',
]

/**
 * Source bytes of the first screen, per client: the files the walk reaches,
 * comments and types included. Measured on 2026-10-31 after the first-screen
 * split (docs/plans/fast-secure-startup.md, step 4), with room for ordinary
 * growth. A feature that comes back into startup through a new static import
 * costs more than the room; move it behind a dynamic import, or raise the
 * budget on purpose with a new measurement. Web measured again on 2026-11-04 at
 * 4,606,354: the dial policy in `host-routes.ts` and `host-link.ts` grew for route
 * control (docs/plans/host-routes.md §12). The route page itself is not in this graph.
 */
const SOURCE_BUDGET_BYTES = {
  web: 4_620_000,
  desktop: 4_700_000,
}

describe('startup import graph', () => {
  for (const [client, roots] of Object.entries(CLIENTS)) {
    const graph = staticGraph(roots)
    // '/' as the paths below name them; Windows gives '\\'.
    const reached = new Set([...graph.files].map((file) => relative(ROOT, file).replaceAll('\\', '/')))

    test(`${client}: the walk reaches the workspace it mounts`, () => {
      // Guards the walker itself: a resolver that silently stops early would
      // make every absence below pass.
      expect(reached.has('packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts')).toBe(true)
      expect(reached.has('packages/workspace-ui/src/components/input/InputBar.svelte')).toBe(true)
      expect(reached.has('packages/workspace-ui/src/components/ui/DeferredPromptEditor.svelte')).toBe(true)
    })

    test(`${client}: a conversation's transcript view loads with the first conversation`, () => {
      // The pane is in startup so a draft turns into a chat without a skeleton;
      // the transcript view behind it is not (LazyConversationView).
      expect(reached.has('packages/workspace-ui/src/components/conversation/ConversationPane.svelte')).toBe(true)
      expect(reached.has('packages/workspace-ui/src/components/conversation/ConversationView.svelte')).toBe(false)
    })

    test(`${client}: heavy packages that only later surfaces use are not part of startup`, () => {
      expect(DEFERRED_PACKAGES.filter((name) => graph.packages.has(name))).toEqual([])
    })

    test(`${client}: the first screen stays inside its source budget`, () => {
      let bytes = 0
      for (const file of graph.files) bytes += statSync(file).size
      expect(bytes).toBeLessThanOrEqual(SOURCE_BUDGET_BYTES[client as keyof typeof SOURCE_BUDGET_BYTES])
    })

    test(`${client}: SQL formatting is not part of startup`, () => {
      expect(graph.packages.has('sql-formatter')).toBe(false)
    })

    test(`${client}: the composer's Markdown does not bring the HTML, CSS, and JavaScript grammars`, () => {
      // `markdown()` from lang-markdown imports lang-html, and with it the CSS and
      // JavaScript grammars: about 170 KB the composer never highlights. The
      // composer uses `markdownLanguage` directly. The walk sees only our imports.
      const editor = readFileSync(join(ROOT, 'packages/workspace-ui/src/components/ui/plain-text-editor/plain-text-editor.svelte'), 'utf8')
      expect(editor).not.toMatch(/import\s*\{[^}]*\bmarkdown\b[^}]*\}\s*from\s*"@codemirror\/lang-markdown"/)
      expect(['@codemirror/lang-html', '@codemirror/lang-javascript', '@codemirror/lang-css'].filter((name) => graph.packages.has(name))).toEqual([])
    })

    test(`${client}: closed optional controls load on first use`, () => {
      expect(DEFERRED_COMPONENTS.filter((file) => reached.has(file))).toEqual([])
    })
  }
})

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
  // Stores the first screen does not use; the contexts barrel does not re-export them.
  'packages/workspace-ui/src/contexts/webhooks/webhooks.store.svelte.ts',
  'packages/workspace-ui/src/contexts/webhooks/webhook-admin.store.svelte.ts',
]

describe('startup import graph', () => {
  for (const [client, roots] of Object.entries(CLIENTS)) {
    const graph = staticGraph(roots)
    // '/' as the paths below name them; Windows gives '\\'.
    const reached = new Set([...graph.files].map((file) => relative(ROOT, file).replaceAll('\\', '/')))

    test(`${client}: the walk reaches the workspace it mounts`, () => {
      // Guards the walker itself: a resolver that silently stops early would
      // make every absence below pass.
      expect(reached.has('packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts')).toBe(true)
      expect(reached.has('packages/workspace-ui/src/components/conversation/ConversationView.svelte')).toBe(true)
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

/**
 * Surface boundary — a portable surface reads stores and shell facts, never the
 * tab strip; a record surface reads `SurfaceContext`, never the workspace.
 *
 * The board surfaces (tasks, works, the workspace ledger, a session record) are
 * mounted by every client: desktop, web, and phone. They stay portable only
 * while they ask the app core for what they need — a store for data,
 * `ClientShellContext` for what the host can do, a context *command* to reach a
 * session — and never read which tabs are open, which is active, or select one.
 * Those are the workspace layout's.
 *
 * A surface that needs to reach a session uses `revealSession`; one that needs
 * the session showing a provider's id uses `sessionForAgentSession`; one that
 * needs the person's current session reads `activeSession`.
 *
 * The record surfaces — the task, pull request, and works boards, a task, a
 * work, a session record — go one step further: they read
 * `getSurfaceContext()` and ask its `workspace` before a workspace-only
 * command. A record renders with no runner behind it — the web client with
 * only the organization's workspace connection — and `SurfaceContext` is what
 * it reads there (`cloud-service-model.md` §15 "One door").
 *
 * Text checker, like `check-layout-discipline.ts`: the reads are in `.svelte`
 * markup and script alike. Run with `bun run lint:surfaces`.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const COMPONENTS_ROOT = 'packages/workspace-ui/src/components'

/** The folders whose surfaces every client mounts. Add a folder here when its
 *  surface is mounted outside the workspace layout for the first time. */
const PORTABLE_FOLDERS = [
  'tasks/',
  'work/',
  'workspace/',
  'document-shell/',
  'diagram/',
  'session/record/',
  'insights/',
]

/** The folders whose surfaces render a record without a workspace
 *  (docs/plans/cloud-console-native-pages.md §4 and §9). Add a folder here
 *  when a surface from it renders a record for the first time. */
const RECORD_SURFACE_FOLDERS = [
  'tasks/',
  'prs/',
  'workspace/',
  'work/',
  'artifact/',
  'document-shell/',
  'document-modal/',
  'diagram/',
  'session/record/',
  'comments/',
  'github-markdown/',
]

/** Files outside those folders that a record surface mounts: the transcript a
 *  session record renders, the markdown a task or a comment renders. */
const RECORD_SURFACE_FILES = new Set([
  'conversation/UserMessageBubble.svelte',
  'conversation/MarkdownLink.svelte',
  'conversation/MarkdownText.svelte',
  'conversation/WebLink.svelte',
  'conversation/FencedBlock.svelte',
  'conversation/HtmlBlock.svelte',
  'conversation/ToolGroupItem.svelte',
  'conversation/AnsweredQuestion.svelte',
  'ui/CodeSpan.svelte',
  'ui/ProjectFavicon.svelte',
  'ui/lib/pane-actions.svelte.ts',
  // The task board's row menu.
  'session/TaskContextMenu.svelte',
])

/** Record-surface files that stay workspace-only on purpose. Each is mounted
 *  behind a `session.workspace` gate by its parent. */
const WORKSPACE_ONLY_RECORD_FILES = new Set([
  // The link picker indexes a machine's docs, plans, automations and PRs.
  'tasks/task-page/TaskLinkPicker.svelte',
  // The detail panel prepares a worktree; a console row opens the code host.
  'prs/PrDetailPanel.svelte',
  // The file preview is the files pane's, with the diff comments of a tab.
  'artifact/FilePreviewStream.svelte',
])

/** Tab-strip state and commands, on any receiver (`session.`, `workspace.`, `ctx.`). */
const TAB_STATE = /\.(tabs|tabOrder|activeTabId|activeTab|selectTab|tabIdForAgentSession)\b/g

const WORKSPACE_READ = /\bgetWorkspaceContext\(/g

type Failure = { path: string; line: number; detail: string }

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.(svelte|ts)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) out.push(full)
  }
  return out
}

export function checkSurfaceBoundary(root = COMPONENTS_ROOT): Failure[] {
  const failures: Failure[] = []
  for (const file of walk(root)) {
    const path = relative(root, file).split(sep).join('/')
    const recordSurface = (RECORD_SURFACE_FOLDERS.some((folder) => path.startsWith(folder)) || RECORD_SURFACE_FILES.has(path)) && !WORKSPACE_ONLY_RECORD_FILES.has(path)
    if (!recordSurface && !PORTABLE_FOLDERS.some((folder) => path.startsWith(folder))) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((text, index) => {
      // A comment may name the forbidden read while explaining what replaced it.
      const code = text.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
      if (PORTABLE_FOLDERS.some((folder) => path.startsWith(folder))) {
        for (const match of code.matchAll(TAB_STATE)) {
          failures.push({ path, line: index + 1, detail: `reads tab state \`${match[0]}\`` })
        }
      }
      if (recordSurface && WORKSPACE_READ.test(code)) {
        failures.push({ path, line: index + 1, detail: 'reads the workspace; a record surface reads `getSurfaceContext()` and asks `.workspace` first' })
      }
      WORKSPACE_READ.lastIndex = 0
    })
  }
  return failures
}

if (import.meta.main) {
  const failures = checkSurfaceBoundary()
  if (failures.length === 0) {
    console.log('surface boundary: clean')
    process.exit(0)
  }
  for (const failure of failures) console.log(`${failure.path}:${failure.line} — ${failure.detail}`)
  console.log(`\n${failures.length} surface-boundary failure(s). A portable surface reads stores and shell facts, never the tab strip: use revealSession, sessionForAgentSession, or activeSession. A record surface reads getSurfaceContext().`)
  process.exit(1)
}

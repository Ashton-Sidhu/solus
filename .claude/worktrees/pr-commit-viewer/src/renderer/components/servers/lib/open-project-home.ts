import type { RecentProject } from '../../../../shared/types'
import type { CloneIntent } from './clone-url'

/**
 * Home's rows in render order. Recents and actions are one list because ↑↓
 * walks them as one: the dialog holds a single index into this array, and the
 * headings between the groups are drawn around it rather than into it.
 */
export type HomeRow =
  /** A clone URL recognised in the search box, offered before anything else. */
  | { key: string; kind: 'clone'; seed: string; repoName: string }
  | { key: string; kind: 'recent'; project: RecentProject }
  | { key: string; kind: 'action'; action: 'browse' | 'github' | 'clone-url' }

export function homeRows(options: {
  intent: CloneIntent
  recents: RecentProject[]
  /** False when this client has no GitHub sign-in to offer the picker at all. */
  githubAvailable: boolean
}): HomeRow[] {
  const rows: HomeRow[] = []
  const { intent } = options
  if (intent.kind === 'clone-url' || intent.kind === 'owner-repo') {
    rows.push({ key: 'clone-intent', kind: 'clone', seed: intent.cloneUrl, repoName: intent.repoName })
  }
  for (const project of options.recents) {
    rows.push({ key: `recent:${project.path}`, kind: 'recent', project })
  }
  rows.push({ key: 'action:browse', kind: 'action', action: 'browse' })
  if (options.githubAvailable) rows.push({ key: 'action:github', kind: 'action', action: 'github' })
  rows.push({ key: 'action:clone-url', kind: 'action', action: 'clone-url' })
  return rows
}

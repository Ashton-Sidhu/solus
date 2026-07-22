import type { PaneSlot } from '../../../contexts/pane-view.store.svelte'
import { abbreviateHome } from '../../../lib/paths'
import { worktreeProjectRoot, type GitCheckout, type RecentProject, type SessionMeta, type WorktreeEntry } from '../../../../shared/types'

export interface HomePresence {
  isActive: boolean
  isFocused: boolean
  isSplit: boolean
}

export function homeGitDetails(
  currentDir: string,
  gitContext: GitCheckout | null | undefined,
  defaultGitContext: GitCheckout | null,
  worktreeBaseBranch: string | null | undefined,
) {
  const currentGitContext = gitContext ?? defaultGitContext
  return {
    projectRoot: currentDir && currentDir !== '~' ? worktreeProjectRoot(currentDir) : null,
    baseBranch: currentGitContext?.targetBranch ?? 'main',
    canToggleWorktree: !!currentGitContext?.targetBranch && !currentGitContext.worktreePath,
  }
}

export function homePresence(
  tabId: string | undefined,
  activeTabId: string,
  tabCount: number,
  focusedPane: PaneSlot,
  secondaryChatTabId: string | null,
): HomePresence {
  const isSplit = !!tabId && tabId === secondaryChatTabId
  const isPrimary = tabId ? tabId === activeTabId && !isSplit : tabCount === 0
  return {
    isActive: isPrimary || isSplit,
    isFocused: isSplit ? focusedPane === 'secondary' : isPrimary && focusedPane === 'primary',
    isSplit,
  }
}

export function launchTargetDetails(
  currentDir: string,
  workspacePath: string | null,
): { isWorkspace: boolean; name: string; sessionsLabel: string } {
  const normalizedDir = currentDir.replace(/\/+$/, '')
  const isWorkspace = !!workspacePath && normalizedDir === workspacePath.replace(/\/+$/, '')
  const name = isWorkspace
    ? 'your workspace'
    : normalizedDir.split('/').pop() || abbreviateHome(currentDir)
  return {
    isWorkspace,
    name,
    sessionsLabel: isWorkspace ? 'Recent in workspace' : `Recent in ${name}`,
  }
}

export function sessionTitle(meta: SessionMeta): string {
  return meta.customTitle || meta.firstMessage?.replace(/\s+/g, ' ') || meta.slug || 'Unnamed session'
}

export type HomeShortcutTarget =
  | { kind: 'workspace' }
  | { kind: 'worktree'; worktree: WorktreeEntry }
  | { kind: 'project'; project: RecentProject }
  | { kind: 'session'; session: SessionMeta }

export function homeShortcutTarget(
  event: Pick<KeyboardEvent, 'altKey' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'code'>,
  options: {
    canGoToWorkspace: boolean
    worktrees: WorktreeEntry[]
    projects: RecentProject[]
    sessions: SessionMeta[]
  },
): HomeShortcutTarget | null {
  if (
    event.altKey &&
    !event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    event.code === 'KeyW'
  ) {
    return options.canGoToWorkspace ? { kind: 'workspace' } : null
  }

  const match = event.code.match(/^Digit(\d)$/)
  if (!match) return null
  const index = Number.parseInt(match[1], 10) - 1
  if (event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
    const worktree = options.worktrees[index]
    return worktree ? { kind: 'worktree', worktree } : null
  }
  if (!event.altKey || !event.shiftKey) return null
  const project = options.projects[index]
  if (project) return { kind: 'project', project }
  const session = options.sessions[index - options.projects.length]
  return session ? { kind: 'session', session } : null
}

export function projectCarouselIndex(
  currentIndex: number,
  touchStartX: number,
  touchEndX: number,
): number {
  const distance = touchStartX - touchEndX
  if (distance > 40) return currentIndex + 1
  if (distance < -40) return currentIndex - 1
  return currentIndex
}

export function hasProjectScrollOverflow(
  scrollLeft: number,
  scrollWidth: number,
  clientWidth: number,
): boolean {
  return scrollLeft + clientWidth < scrollWidth - 10
}

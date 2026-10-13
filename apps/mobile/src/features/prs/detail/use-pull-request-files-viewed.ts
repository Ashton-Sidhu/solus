// Adapted from T3 Code apps/mobile/src/features/pull-requests/usePullRequestFilesViewed.ts (MIT, see UPSTREAM.md).
import { useEffect, useState } from 'react'
import type { PrViewedFiles } from '@solus/contracts/providers'
import { useApp, useListened } from '../../../app/app-context'
import { viewedFilesOnHost } from '../lib/pull-request-permissions'
import { shownValue } from '../pull-request-reads'
import { OFFLINE_REASON, type PullRequestView } from './pull-request-view'

export interface FilesViewed {
  isViewed(path: string): boolean
  /** Answers false when the mark cannot be changed now. */
  toggle(path: string): boolean
  /** Files marked viewed that changed after that: they need another look. */
  dismissed: readonly string[]
  /** Why a tap does nothing now, or why the last write failed. */
  note: string | null
}

/**
 * The files the person marked viewed. When the host keeps GitHub's viewed
 * state (`capabilities.viewedFiles`), GitHub's state is the record: it is read
 * when the pull request opens, a tap writes to it, and the device copy is only
 * for offline display. An older host has no viewed state, so the marks stay on
 * this device for one head of one pull request, as before. The changes of one
 * commit keep their marks for this visit only.
 */
export function usePullRequestFilesViewed(view: PullRequestView, commitSha: string | null): FilesViewed {
  const onHost = viewedFilesOnHost(view.pr, commitSha)
  const host = useHostFilesViewed(view, onHost)
  const device = useDeviceFilesViewed(view, onHost ? null : commitSha, !onHost)
  return onHost ? host : device
}

const NO_FILES: PrViewedFiles = { files: [], complete: true }

function useHostFilesViewed(view: PullRequestView, enabled: boolean): FilesViewed {
  const app = useApp()
  const { ref } = view
  const state = useListened(app.pullRequests.changes, () => app.pullRequests.viewedOf(ref))
  const marks = useListened(app.pullRequestActions.changes, () => app.pullRequestActions.viewedMarksOf(ref))
  const writeError = useListened(app.pullRequestActions.changes, () => app.pullRequestActions.viewedErrorOf(ref))
  const files = shownValue(state) ?? NO_FILES
  const headSha = view.pr.headSha

  // GitHub's state is read again when the pull request opens or its head moves.
  useEffect(() => {
    if (enabled) void app.pullRequests.loadViewed(ref)
  }, [app, enabled, ref, headSha])
  // Marks that wait are sent when the pull request closes.
  useEffect(() => (enabled ? () => void app.pullRequestActions.sendViewed(ref) : undefined), [app, enabled, ref])

  const stateOf = (path: string) => files.files.find((file) => file.path === path)?.state
  const isViewed = (path: string) => marks.get(path) ?? stateOf(path) === 'viewed'
  const readable = shownValue(state) !== null
  const note = !view.permissions.connected
    ? OFFLINE_REASON
    : writeError ?? (state.kind === 'error' ? `Viewed files not refreshed: ${state.message}` : null)
  return {
    isViewed,
    toggle: (path) => {
      if (!enabled || !view.permissions.connected || !readable) return false
      try {
        app.pullRequestActions.markFileViewed(ref, path, !isViewed(path))
        return true
      } catch {
        return false
      }
    },
    dismissed: files.files.filter((file) => file.state === 'dismissed' && !marks.has(file.path)).map((file) => file.path),
    note,
  }
}

function useDeviceFilesViewed(view: PullRequestView, commitSha: string | null, enabled: boolean): FilesViewed {
  const app = useApp()
  const { ref } = view
  const key = !enabled || commitSha ? null : `viewed:${ref.projectPath}:${ref.number}:${view.pr.headSha}`
  const scope = `${ref.hostId}\u0000${key ?? `commit:${commitSha}`}`
  const [state, setState] = useState<{ scope: string; paths: ReadonlySet<string> }>({ scope, paths: new Set() })
  const paths = state.scope === scope ? state.paths : new Set<string>()

  useEffect(() => {
    if (!key) return
    let current = true
    void app.pullRequestCache.read<string[]>(ref.hostId, key).then((kept) => {
      // A toggle made before the read lands wins.
      if (current && kept) setState((previous) => previous.scope === scope && previous.paths.size > 0 ? previous : { scope, paths: new Set(kept) })
    })
    return () => { current = false }
  }, [app, key, ref.hostId, scope])

  return {
    isViewed: (path) => paths.has(path),
    toggle: (path) => {
      const next = new Set(paths)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      setState({ scope, paths: next })
      if (key) void app.pullRequestCache.write(ref.hostId, key, Array.from(next))
      return true
    },
    dismissed: [],
    note: null,
  }
}

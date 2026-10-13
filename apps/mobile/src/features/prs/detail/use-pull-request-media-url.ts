// Adapted from T3 Code apps/mobile/src/features/pull-requests/PullRequestMedia.tsx (MIT, see UPSTREAM.md).
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { githubMediaFetchUrl } from '@solus/contracts/github-media'
import { useApp } from '../../../app/app-context'
import type { PullRequestRef } from '../pull-request-directory'
import { pullRequestMediaUrl } from '../pull-request-media'

/** The pull request whose host signs the GitHub media of the text below it. */
export const PullRequestMediaContext = createContext<Pick<PullRequestRef, 'hostId' | 'projectPath'> | null>(null)

export interface PullRequestMediaUrl {
  /** Null while the host signs GitHub media. */
  uri: string | null
  /** Signs again, for a player whose URL expired. */
  resolvePlaybackUri: () => Promise<string | null>
}

/**
 * The address to load one image or video from. GitHub media waits for the
 * host's signed URL (null until then), so a private upload does not first
 * show as broken; other media loads directly.
 */
export function usePullRequestMediaUrl(url: string): PullRequestMediaUrl {
  const app = useApp()
  const location = useContext(PullRequestMediaContext)
  const signed = location !== null && githubMediaFetchUrl(url) !== null
  const [resolved, setResolved] = useState<{ url: string; uri: string } | null>(null)

  const resolve = useCallback((refresh: boolean) => {
    if (!location) return Promise.resolve(url)
    const connection = app.connections.connection(location.hostId)
    return pullRequestMediaUrl(connection, url, app.pullRequests.context(location.projectPath), refresh)
  }, [app, location, url])

  useEffect(() => {
    if (!signed) return
    let active = true
    void resolve(false).then((uri) => { if (active) setResolved({ url, uri }) })
    return () => { active = false }
  }, [signed, resolve, url])

  return {
    uri: !signed ? url : resolved?.url === url ? resolved.uri : null,
    resolvePlaybackUri: () => resolve(true),
  }
}

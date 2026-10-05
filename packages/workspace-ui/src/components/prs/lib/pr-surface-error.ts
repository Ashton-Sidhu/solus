import type { PrUnavailableReason } from '@solus/contracts/providers'

export type PrSurfaceError =
  | { kind: 'github-auth' | 'generic'; message: string }
  /** A project with no pull requests to read — a chat, a plain folder, a
   *  repository that was never pushed. Not a failure, so no surface reports it
   *  as one. The host names the reason; nothing parses it out of a message. */
  | { kind: 'unavailable'; reason: PrUnavailableReason; message: string }

const GITHUB_AUTH_MESSAGES = [
  'GitHub is not connected',
  'Your GitHub authorization is no longer valid. Reconnect GitHub to continue.',
]

export function prSurfaceError(error: Parameters<typeof String>[0]): PrSurfaceError {
  const message = error instanceof Error ? error.message : String(error)
  return { kind: GITHUB_AUTH_MESSAGES.some((candidate) => message.includes(candidate)) ? 'github-auth' : 'generic', message }
}

const UNAVAILABLE_MESSAGES = {
  'not-a-repository': 'This folder is not a git repository.',
  'no-remote': 'This repository has no git remote.',
  'unsupported-host': 'Solus can’t read pull requests from this repository’s host yet.',
} satisfies Record<PrUnavailableReason, string>

export function prUnavailable(reason: PrUnavailableReason): PrSurfaceError {
  return { kind: 'unavailable', reason, message: UNAVAILABLE_MESSAGES[reason] }
}

/** The project's own name in the statement: the page scope is shared with the
 *  other project pages, so the project may have been picked on another one. */
export function prUnavailableTitle(reason: PrUnavailableReason, projectLabel: string | null): string {
  if (!projectLabel) return UNAVAILABLE_MESSAGES[reason]
  if (reason === 'not-a-repository') return `${projectLabel} is not a git repository.`
  if (reason === 'no-remote') return `${projectLabel} has no git remote.`
  return `Solus can’t read pull requests from ${projectLabel}’s host yet.`
}

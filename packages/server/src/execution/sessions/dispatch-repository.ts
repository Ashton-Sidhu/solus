import type { DispatchRepository } from '@solus/contracts/types'
import type { Principal } from '../../admission/principal'

/** The repository a run copies to this host before it starts (docs/run-on.md). */
export interface RepositoryRun {
  repository: DispatchRepository
  /** The paired device that sent the run. A dispatch checkout belongs to it (ADR-0011). */
  deviceId?: string
}

/** What a repository preparation tells the run while it works. */
export interface RepositoryProgress {
  /** One line of output. `isProgress` marks a line that git writes again in
   *  place (a transfer count), not a new line. */
  onOutput(line: string, isProgress: boolean): void
  signal: AbortSignal
}

/**
 * Makes the caller's dispatch checkout of a repository ready on this host and
 * answers the folder the run starts in. The setup domain owns cloning, so the
 * host gives this to the run launcher at boot.
 */
export type PrepareDispatchCheckout = (
  repository: DispatchRepository,
  caller: { principal: Principal; deviceId?: string },
  progress: RepositoryProgress,
) => Promise<string>

/**
 * The folder of the caller's dispatch checkout of a repository on this host,
 * whether or not the copy exists yet. The prepare step copies to this same
 * folder, so a turn's admission and its first recorded facts can name it before
 * the copy starts. A client never names this folder.
 */
export type DispatchCheckoutPathOf = (
  repository: DispatchRepository,
  caller: { principal: Principal; deviceId?: string },
) => string

/** The last percentage in a line of git progress, such as
 *  `Receiving objects:  42% (420/1000)`, or null when it has none. */
export function progressPercent(line: string): number | null {
  const matches = [...line.matchAll(/(\d{1,3})%/g)]
  const last = matches.at(-1)
  if (!last) return null
  const percent = Number(last[1])
  return percent <= 100 ? percent : null
}

/**
 * Lets an update through at most once in each `intervalMs`. The caller always
 * publishes the final state itself, so an update that this drops is never the
 * last one a reader sees.
 */
export function progressThrottle(intervalMs: number, now: () => number = Date.now): () => boolean {
  let lastAt = -Infinity
  return () => {
    const at = now()
    if (at - lastAt < intervalMs) return false
    lastAt = at
    return true
  }
}

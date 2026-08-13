import type { RunConfig } from '../../../../shared/types'
import { isDispatch, startsWorktree } from '../../../contexts/workspace/run-config'
import { worktreeBlockedReason } from '../run-on'

/**
 * Where the next session runs, and what that implies — the single answer the
 * Run on picker renders.
 *
 * Three kinds, because a remote host means two genuinely different things and
 * conflating them is what made this control hard to read:
 *
 * - `local` — the agent runs on the host that owns the project. Worktree mode is
 *   a free choice.
 * - `dispatched` — the project is here, the agent was sent elsewhere. The task
 *   stays behind; the target can use a new or existing worktree.
 * - `remote` — the project itself was opened on another host. It is that host's
 *   project in every respect, so this behaves exactly like `local` and only the
 *   name on the trigger differs.
 *
 * `dispatched` and `remote` both display a remote host name while behaving
 * oppositely, which is why the kind is derived from the run config's two host ids
 * rather than from any single flag.
 */
export type RunTargetKind = 'local' | 'dispatched' | 'remote'

export interface RunTargetInput {
  run: RunConfig
  /** Display name of the host the agent will run on. */
  hostLabel: string
  /** Display name of the host that owns the project, when it differs. */
  taskHostLabel: string
  /** What "run here" is called: the device on desktop, the bound host on web. */
  stayLabel: string
  /** Whether the execution host is this client's own. The registry answers it —
   *  on web no host is truly local, so the id alone cannot. */
  hostIsLocal: boolean
  /** The run already sits inside a worktree, rather than about to branch one. */
  isolated: boolean
  /** This checkout has a base branch a worktree could be branched from. */
  canBranchWorktree: boolean
}

export interface RunTarget {
  kind: RunTargetKind
  /** What the trigger reads. */
  label: string
  /** The next session branches its own worktree before the agent starts. */
  startsWorktree: boolean
  /** Isolation is not the user's to decline here, so the rows show it chosen
   *  and disabled rather than silently overruling a click. */
  worktreeForced: boolean
  /** Why the worktree rows are unavailable, or null when they are selectable. */
  worktreeBlockedNote: string | null
  /** Where the task is filed, stated only when that is not where it runs — the
   *  one consequence of dispatch a user cannot otherwise see. */
  taskNote: string | null
}

export function runTarget(input: RunTargetInput): RunTarget {
  const { run, hostLabel, taskHostLabel, stayLabel, hostIsLocal, isolated, canBranchWorktree } = input
  // A picker choice is already the next run target even though the host move
  // waits for Send. Render that pending dispatch with the same worktree and task
  // ownership semantics as a dispatch that has finished preparation.
  const dispatched = run.pendingHostDispatch?.intent === 'dispatch' || isDispatch(run)
  const onOwnRemoteHost = !dispatched && !hostIsLocal

  const kind: RunTargetKind = dispatched
    ? 'dispatched'
    : onOwnRemoteHost
      ? 'remote'
      : 'local'
  const worktree = startsWorktree(run)

  if (kind === 'dispatched') {
    return {
      kind,
      label: hostLabel,
      startsWorktree: worktree,
      worktreeForced: worktree,
      // The target checkout resolves its own default branch during Send. A
      // detached source checkout must not block a new worktree on that host.
      worktreeBlockedNote: null,
      taskNote: null,
    }
  }

  return {
    kind,
    // A remote project is named for its host; a local one is named for the
    // shape of the checkout, which is the only thing that varies there.
    label: kind === 'remote'
      ? hostLabel
      : worktree && !isolated
        ? 'New worktree'
        : stayLabel,
    startsWorktree: worktree,
    worktreeForced: false,
    worktreeBlockedNote: worktreeBlockedReason(canBranchWorktree),
    taskNote: null
  }
}

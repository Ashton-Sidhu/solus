import type { GitCheckout, RunConfig } from '../../../shared/types'
import { MODEL_PROFILES, worktreeProjectRoot } from '../../../shared/types'

/**
 * The rules that operate on a `RunConfig` — where a session starts and what it
 * runs with. Pure functions of run configs and nothing else, which is what lets
 * a started session and a session draft share every one of them: both hold the
 * same object in the same position.
 */

/**
 * What a new session runs with, given the app's defaults and — when there is one
 * — the session it was opened from. A plain function of two run configs, which
 * is the whole rule: everything a draft needs to know about its environment is
 * already a `RunConfig`, so nothing else has to be passed in.
 *
 * Three fields deliberately do *not* carry over, because they describe one
 * session's history rather than where the next one should start.
 */
export function inheritRunConfig(
  defaults: RunConfig,
  inherit?: RunConfig | null,
  /** An explicit demand — the Run-on-host picker requires its own worktree, so
   *  it overrules both the inherited checkout and the saved default. */
  worktreeRequested?: boolean,
): RunConfig {
  const source = inherit ?? defaults
  // A new session follows the saved default. Per-session toggles belong to that
  // session and must not silently decide where the next one starts — and a
  // session already inside a worktree does not branch another one from it.
  const worktreeRequired = worktreeRequested
    ?? (!source.gitContext?.worktreePath && defaults.worktreeRequired)

  return {
    ...source,
    gitContext: source.gitContext ? { ...source.gitContext } : null,
    modelConfig: {
      ...source.modelConfig,
      // The model's own default, not whatever the last session was tuned to.
      reasoningEffort: modelDefaultEffort(source) ?? defaults.modelConfig.reasoningEffort,
    },
    sessionSkills: [...source.sessionSkills],
    worktreeRequired,
    worktreeBaseBranch: worktreeRequired ? source.gitContext?.targetBranch ?? null : null,
    // Permission mode is an app-level preference, never inherited from a session
    // that happened to be loosened for one piece of work.
    permissionMode: defaults.permissionMode,
    // A host choice is inert until Send, so it belongs to the session that made
    // it and not to the next one.
    pendingHostDispatch: null,
  }
}

/** The reasoning effort a model ships with, or null when it declares none. */
function modelDefaultEffort(run: RunConfig): RunConfig['modelConfig']['reasoningEffort'] | null {
  if (!run.modelConfig.modelId || !run.provider) return null
  const profiles = MODEL_PROFILES[run.provider as keyof typeof MODEL_PROFILES]
  return profiles?.[run.modelConfig.modelId]?.defaultReasoningEffort ?? null
}

/**
 * The project a run config belongs to — the repo rather than the checkout —
 * or null when it names none. "New task" means new work on the project, so it
 * anchors here: inheriting a worktree path would bury the new session in a
 * branch the user has already moved on from.
 */
export function projectRootOf(run: RunConfig | null | undefined): string | null {
  if (!run) return null
  return run.gitContext?.repoRoot
    ?? (run.workingDirectory && run.workingDirectory !== '~' ? run.workingDirectory : null)
}

/**
 * Point a run at a directory and whatever checkout was resolved for it.
 *
 * The three ways a person changes where work happens — picking a project,
 * checking out a branch, entering an existing worktree — differ only in how
 * they arrive at these two values, so they share the rule rather than each
 * restating it. A pending worktree request is always cleared: it described the
 * *previous* directory, and carrying it over would branch from the wrong place.
 */
export function withCheckout(
  run: RunConfig,
  workingDirectory: string,
  gitContext: GitCheckout | null,
): RunConfig {
  return {
    ...run,
    workingDirectory,
    gitContext,
    worktreeBaseBranch: null,
  }
}

/**
 * Flip where the next session starts: directly in its checkout, or in a
 * worktree branched from it.
 *
 * Compare `workingDirectory` against the input to tell whether the run was
 * re-anchored to the project root — that is the only case where anything keyed
 * on the directory needs refreshing.
 *
 * Only meaningful before a session starts — a running one moves through
 * `continueInWorktree` instead.
 */
export function withWorktreeToggled(run: RunConfig): RunConfig {
  if (!run.gitContext?.worktreePath) {
    return {
      ...run,
      worktreeBaseBranch: run.worktreeBaseBranch ? null : run.gitContext?.targetBranch ?? null,
    }
  }

  const targetBranch = run.gitContext.targetBranch
  // Nothing to branch from, so there is no second state to flip into.
  if (!targetBranch) return run
  if (run.worktreeBaseBranch) return { ...run, worktreeBaseBranch: null }

  // Worktree creation expects a project-root checkout plus its target branch,
  // so an unstarted run is re-anchored into that shape rather than the creation
  // path learning a second one.
  const projectRoot = run.gitContext.repoRoot ?? worktreeProjectRoot(run.gitContext.worktreePath)
  return {
    ...run,
    workingDirectory: projectRoot,
    gitContext: { repoRoot: projectRoot, branch: targetBranch, targetBranch },
    worktreeBaseBranch: targetBranch,
  }
}

/**
 * Point a run at another host.
 *
 * The old host's checkout describes a filesystem this run no longer uses, so it
 * is dropped rather than carried across and re-read as truth. Staying on the
 * same host keeps whatever the run already had.
 */
export function withHost(
  run: RunConfig,
  serverId: string,
  opts: { path?: string; isLocalHost: boolean; requireWorktree: boolean },
): RunConfig {
  const movingHosts = run.serverId !== serverId
  const next: RunConfig = {
    ...run,
    serverId,
    ...(opts.path ? { workingDirectory: opts.path } : {}),
  }
  if (!movingHosts) return next
  return {
    ...next,
    gitContext: null,
    worktreeBaseBranch: null,
    worktreeRequired: opts.requireWorktree && !opts.isLocalHost,
  }
}

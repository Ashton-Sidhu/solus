import type { GitCheckout, ModelConfig, PendingHostDispatch, RunConfig, WorktreeEntry } from '@solus/contracts/types'
import { MODEL_PROFILES, worktreeProjectRoot } from '@solus/contracts/types'

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
  opts: {
    /** The app-level "start new sessions in a worktree" preference. */
    worktreeEnabled?: boolean
    /** An explicit demand, which overrules both the inherited checkout and the
     *  saved preference. */
    worktreeRequested?: boolean
  } = {},
): RunConfig {
  const source = inherit ?? defaults
  // A new session follows the saved preference. Per-session toggles belong to
  // that session and must not silently decide where the next one starts — and a
  // session already inside a worktree does not branch another one from it.
  const branchesWorktree = opts.worktreeRequested
    ?? (!source.gitContext?.worktreePath && !!opts.worktreeEnabled)

  return {
    ...source,
    gitContext: source.gitContext ? { ...source.gitContext } : null,
    modelConfig: {
      ...source.modelConfig,
      // The model's own default, not whatever the last session was tuned to.
      reasoningEffort: modelDefaultEffort(source) ?? defaults.modelConfig.reasoningEffort,
    },
    sessionSkills: [...source.sessionSkills],
    worktree: branchesWorktree ? { baseBranch: source.gitContext?.targetBranch ?? null } : null,
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
  const profiles = MODEL_PROFILES[run.provider]
  return profiles?.[run.modelConfig.modelId]?.defaultReasoningEffort ?? null
}

/**
 * The model after the run's current one in its provider's list, wrapping around
 * — what "cycle model" lands on. Null when the provider offers no models. Reads
 * the run, so a draft and a started session answer it the same way.
 */
export function cycledModelId(
  run: RunConfig,
  models: readonly { id: string }[],
  defaultModelId: string | null,
): string | null {
  if (models.length === 0) return null
  const current = run.modelConfig.modelId || defaultModelId || models[0].id
  const idx = models.findIndex((model) => model.id === current)
  return models[((idx === -1 ? 0 : idx) + 1) % models.length].id
}

/**
 * The model config a run takes on when it switches to `modelId`: the model's own
 * profile defaults, never the outgoing model's tuning. Each model ships its own
 * reasoning effort, context window, and fast-mode support, so carrying the old
 * values over would run the new model against limits it never declared.
 */
export function modelConfigForModel(run: RunConfig, modelId: string): ModelConfig {
  const profile = run.provider ? MODEL_PROFILES[run.provider]?.[modelId] : undefined
  return {
    modelId,
    reasoningEffort: profile?.defaultReasoningEffort ?? 'high',
    contextWindow: profile?.defaultContextWindow ?? null,
    fastMode: profile?.supportsFastMode ? run.modelConfig.fastMode : false,
  }
}

const PERMISSION_MODES = ['ask', 'auto', 'plan'] as const

/** The permission mode after `mode`, wrapping ask → auto → plan → ask. */
export function nextPermissionMode(mode: RunConfig['permissionMode']): RunConfig['permissionMode'] {
  const idx = PERMISSION_MODES.indexOf(mode)
  return PERMISSION_MODES[(idx + 1) % PERMISSION_MODES.length]
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
 * restating it. The resolved base branch is always cleared — it named a branch in
 * the *previous* directory, and carrying it over would branch from the wrong
 * place — while the request itself survives, because wanting isolation is a
 * preference about the work, not about which folder it happens in.
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
    worktree: run.worktree ? { baseBranch: null } : null,
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
      worktree: run.worktree ? null : { baseBranch: run.gitContext?.targetBranch ?? null },
    }
  }

  const targetBranch = run.gitContext.targetBranch
  // Nothing to branch from, so there is no second state to flip into.
  if (!targetBranch) return run
  if (run.worktree) return { ...run, worktree: null }

  // Worktree creation expects a project-root checkout plus its target branch,
  // so an unstarted run is re-anchored into that shape rather than the creation
  // path learning a second one.
  const projectRoot = run.gitContext.repoRoot ?? worktreeProjectRoot(run.gitContext.worktreePath)
  return {
    ...run,
    workingDirectory: projectRoot,
    gitContext: { repoRoot: projectRoot, branch: targetBranch, targetBranch },
    worktree: { baseBranch: targetBranch },
  }
}

/**
 * Whether this run is a dispatch: the agent runs on one host while the project
 * — and therefore the task — belongs to another.
 *
 * Reads the run config rather than a session, so a draft answers it identically.
 */
export function isDispatch(run: RunConfig | undefined | null): boolean {
  return !!run && run.serverId !== run.taskServerId
}

/**
 * Whether this run will branch its own worktree before the agent starts.
 *
 * A dispatch always uses a worktree. `worktree` requests a new one; a selected
 * pending target worktree is already isolated and therefore needs no creation.
 */
export function startsWorktree(run: RunConfig | undefined | null): boolean {
  if (!run) return false
  if (run.pendingHostDispatch?.intent === 'dispatch' && run.pendingHostDispatch.worktree) return false
  return (isDispatch(run) && !run.gitContext?.worktreePath) || !!run.worktree
}

/**
 * Point a run at another host to *run on*, leaving the project where it is.
 *
 * The old host's checkout describes a filesystem this run no longer uses, so it
 * is dropped rather than carried across and re-read as truth. `taskServerId` is
 * deliberately untouched: the project did not move, so neither did its tasks,
 * and that difference is what later reads back as "this is a dispatch". Staying
 * on the same host keeps whatever the run already had.
 */
export function withHost(
  run: RunConfig,
  serverId: string,
  opts: { path?: string },
): RunConfig {
  const movingHosts = run.serverId !== serverId
  const next: RunConfig = {
    ...run,
    serverId,
  }
  if (opts.path) next.workingDirectory = opts.path
  if (!movingHosts) return next
  // The old host's base branch named a branch over there, so a worktree survives
  // the move as a request with its answer dropped.
  return { ...next, gitContext: null, worktree: run.worktree ? { baseBranch: null } : null }
}

/**
 * Point a run at a project that lives on another host — its tasks included.
 *
 * The opposite of `withHost`: opening a folder on a host makes that host the
 * project's own, so both ids move together and nothing about the run is a
 * dispatch. Worktree mode stays the user's choice, exactly as it is locally.
 */
export function withProjectHost(
  run: RunConfig,
  serverId: string,
  opts: { path?: string },
): RunConfig {
  return { ...withHost(run, serverId, opts), taskServerId: serverId }
}

/**
 * Record a host choice without acting on it. The move happens on Send, which is
 * why this only writes intent: choosing "run on Studio" and then changing your
 * mind should cost nothing. Picking the host you are already on clears it.
 */
export function withPendingHost(
  run: RunConfig,
  target: PendingHostDispatch | null,
): RunConfig {
  return {
    ...run,
    pendingHostDispatch: target && target.serverId !== run.serverId ? target : null,
  }
}

/** Choose where a pending remote dispatch works. An existing worktree records
 * its exact target-host path. Null returns to creating a new isolated worktree. */
export function withDispatchWorktree(run: RunConfig, worktree: WorktreeEntry | null): RunConfig {
  const pending = run.pendingHostDispatch
  if (pending?.intent !== 'dispatch') return run
  const pendingHostDispatch: PendingHostDispatch = {
    serverId: pending.serverId,
    intent: 'dispatch',
    repoKey: pending.repoKey,
  }
  if (worktree) {
    pendingHostDispatch.worktree = { path: worktree.path, branch: worktree.branch }
  }
  return {
    ...run,
    worktree: worktree ? null : { baseBranch: null },
    pendingHostDispatch,
  }
}

/** Materialize an origin branch as a target-host worktree. This records only
 * intent; it never checks out the branch in the source repository. */
export function withDispatchBaseBranch(run: RunConfig, baseBranch: string): RunConfig {
  const pending = run.pendingHostDispatch
  if (pending?.intent !== 'dispatch') return run
  return {
    ...run,
    worktree: { baseBranch },
    pendingHostDispatch: {
      serverId: pending.serverId,
      intent: 'dispatch',
      repoKey: pending.repoKey,
      baseBranch,
    },
  }
}

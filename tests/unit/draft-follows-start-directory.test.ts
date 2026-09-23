import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { RunConfig, Session, StartInfo } from '@solus/contracts/types'

/**
 * A first run on a client origin has no cached start payload, so the composer is
 * seeded at `~` before start() lands. The reconciliation that moves it onto the
 * real workspace has to reach a *draft* as well as a tab: a draft has no session
 * and no tab, so the tab registry cannot see it, and a draft left at `~` sends
 * its first prompt into the home directory instead of the project.
 *
 * Reproduced on the standalone web client, where every new origin is a first run.
 */

const previousState = (globalThis as unknown as { $state?: unknown }).$state
let WorkspaceLifecycleStore: typeof import('@solus/workspace-ui/contexts/workspace/workspace-lifecycle.store.svelte')['WorkspaceLifecycleStore']

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
  ;({ WorkspaceLifecycleStore } = await import('@solus/workspace-ui/contexts/workspace/workspace-lifecycle.store.svelte'))
})

afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

const WORKSPACE = '/Users/sidhu/.solus/my-workspace'
const HOME = '/Users/sidhu'

function run(workingDirectory: string): RunConfig {
  return {
    provider: 'claude-code',
    workingDirectory,
    gitContext: null,
    modelConfig: { modelId: 'claude-opus-5', reasoningEffort: 'medium', contextWindow: null, fastMode: false },
  } as RunConfig
}

/**
 * `unstartedRuns` is the union the workspace exposes: the runs of unstarted tabs
 * plus every open draft. `tabSessions` is only what the registry can reach, which
 * is what makes the draft-only case meaningful.
 */
/** A tab that has begun nothing, which is what makes it free to be retargeted. */
function unstartedSession(workingDirectory: string) {
  return { run: run(workingDirectory), agentSessionId: null, messages: [], status: 'idle' }
}

function lifecycleFor(options: {
  /** The project the last session started in, which outranks the workspace. */
  lastProject?: string
  tabSessions?: Record<string, ReturnType<typeof unstartedSession>>
  draftRuns?: RunConfig[]
}) {
  const tabSessions = options.tabSessions ?? {}
  const draftRuns = options.draftRuns ?? []
  const gitRefreshedTabIds: string[] = []
  // The workspace's own rule, reduced to its two inputs: the last project, else
  // the workspace path the start payload carries, else `~` before it lands.
  const defaultRunConfig = () => run(options.lastProject ?? store.staticInfo?.workspacePath ?? '~')
  const store: InstanceType<typeof WorkspaceLifecycleStore> = new WorkspaceLifecycleStore({
    registry: {
      tabOrder: Object.keys(tabSessions),
      sessionFor: (tabId: string) => tabSessions[tabId] as unknown as Session | undefined,
    },
    settings: { activeAgent: 'claude-code' },
    config: {
      followActiveSessionAgent: () => {},
      defaultModelConfigFor: () => ({ modelId: '', reasoningEffort: 'medium', contextWindow: null, fastMode: false }),
    },
    planStore: { hydrateAnnotations() {} },
    agent: { hydrate() {} },
    defaultRunConfig,
    unstartedRuns: () => [...Object.values(tabSessions).map((session) => session.run), ...draftRuns],
    refreshGitState: async (opts?: { sourceId?: string }) => {
      if (opts?.sourceId) gitRefreshedTabIds.push(opts.sourceId)
      return { ok: true }
    },
    ctxFor: () => ({ session: { sessionId: 'tab-1' } }),
    loadTranscript: async () => ({ messages: [], progress: null, planIds: [] }),
    rebuildAgentConversations: () => {},
  } as never)
  const applyStartInfo = () => {
    ;(store as unknown as { applyStartInfo(result: StartInfo, opts: { fresh: boolean }): void })
      .applyStartInfo(
        { version: '0', projectPath: HOME, homePath: HOME, workspacePath: WORKSPACE, agents: [] } as unknown as StartInfo,
        { fresh: true },
      )
  }
  return { applyStartInfo, defaultRunConfig, gitRefreshedTabIds }
}

describe('the start directory a first run reconciles onto', () => {
  test('carries a draft off `~` onto the workspace', () => {
    const draftRun = run('~')
    const { applyStartInfo, defaultRunConfig } = lifecycleFor({ draftRuns: [draftRun] })

    applyStartInfo()

    expect(defaultRunConfig().workingDirectory).toBe(WORKSPACE)
    // Without this the draft still reads `~`, so the pane drops the project from
    // its heading and the first prompt runs in the home directory.
    expect(draftRun.workingDirectory).toBe(WORKSPACE)
    expect(draftRun.gitContext).toBeNull()
  })

  test('leaves a draft the user already pointed somewhere alone', () => {
    const draftRun = run('/repo')
    const { applyStartInfo } = lifecycleFor({ draftRuns: [draftRun] })

    applyStartInfo()

    // Only the runs still sitting on the default follow it; a chosen project is
    // a choice, not a default.
    expect(draftRun.workingDirectory).toBe('/repo')
  })

  test('moves nothing when the last project, not the workspace, is the default', () => {
    // The seeded draft already opened on the last project. The start payload
    // names the workspace, but the workspace is not the default, so the draft
    // must not be dragged there.
    const draftRun = run('/repo')
    const { applyStartInfo } = lifecycleFor({ lastProject: '/repo', draftRuns: [draftRun] })

    applyStartInfo()

    expect(draftRun.workingDirectory).toBe('/repo')
  })

  test('still carries an unstarted tab and refreshes git against that tab', () => {
    const tab = unstartedSession('~')
    const { applyStartInfo, gitRefreshedTabIds } = lifecycleFor({
      tabSessions: { 'tab-1': tab },
    })

    applyStartInfo()

    expect(tab.run.workingDirectory).toBe(WORKSPACE)
    // The refresh is keyed on the tab that moved, so it must survive the draft
    // retarget being read from a collection that has no tab ids in it.
    expect(gitRefreshedTabIds).toEqual(['tab-1'])
  })

  test('refreshes git only for the tabs that actually moved', () => {
    const { applyStartInfo, gitRefreshedTabIds } = lifecycleFor({
      tabSessions: { 'tab-moving': unstartedSession('~'), 'tab-settled': unstartedSession(WORKSPACE) },
    })

    applyStartInfo()

    expect(gitRefreshedTabIds).toEqual(['tab-moving'])
  })
})

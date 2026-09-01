import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { AgentId, AgentMetadata, ModelConfig, RunConfig, StartInfo } from '@solus/contracts/types'

/**
 * A host with only one agent installed must not be handed the other one by a
 * default that was saved before availability was known. The seeded composer is
 * built from that saved default before start() lands, so the demotion has to
 * reach the work that has not begun — not only the setting.
 */

const previousState = (globalThis as unknown as { $state?: unknown }).$state
let WorkspaceLifecycleStore: typeof import('@solus/workspace-ui/contexts/workspace/workspace-lifecycle.store.svelte')['WorkspaceLifecycleStore']
let runnableAutomationAgent: typeof import('@solus/workspace-ui/components/automations/lib/automation-agent')['runnableAutomationAgent']

beforeAll(async () => {
  ;(globalThis as unknown as { $state: unknown }).$state = Object.assign(
    <T>(value: T) => value,
    { snapshot: <T>(value: T) => value },
  )
  ;({ WorkspaceLifecycleStore } = await import('@solus/workspace-ui/contexts/workspace/workspace-lifecycle.store.svelte'))
  ;({ runnableAutomationAgent } = await import('@solus/workspace-ui/components/automations/lib/automation-agent'))
})

afterAll(() => {
  if (previousState === undefined) delete (globalThis as unknown as { $state?: unknown }).$state
  else (globalThis as unknown as { $state: unknown }).$state = previousState
})

function agent(id: AgentId, available: boolean): AgentMetadata {
  return { id, label: id, available, models: [], defaultModel: '' } as AgentMetadata
}

function run(provider: AgentId | null): RunConfig {
  return {
    provider,
    workingDirectory: '/repo',
    modelConfig: { modelId: 'claude-opus-5', reasoningEffort: 'high', contextWindow: null, fastMode: false },
  } as RunConfig
}

const CODEX_DEFAULT: ModelConfig = {
  modelId: 'gpt-5.6-luna',
  reasoningEffort: 'medium',
  contextWindow: null,
  fastMode: false,
}

/** The seeded composer plus the setting, as the demotion sees them. */
function lifecycleFor(activeAgent: AgentId, runs: RunConfig[]) {
  const settings = { activeAgent }
  const store = new WorkspaceLifecycleStore({
    registry: { tabOrder: [], sessionFor: () => undefined },
    settings,
    config: {
      followActiveSessionAgent: (agentId: AgentId) => { settings.activeAgent = agentId },
      defaultModelConfigFor: () => ({ ...CODEX_DEFAULT }),
      globalDefaults: { workingDirectory: '/repo' },
    },
    planStore: { hydrateAnnotations() {} },
    agent: { hydrate() {} },
    unstartedRuns: () => runs,
    refreshGitState: async () => ({ ok: true }),
    ctxFor: () => ({ session: { sessionId: 'tab-1' } }),
    loadTranscript: async () => ({ messages: [], progress: null, planIds: [] }),
    rebuildAgentConversations: () => {},
  } as never)
  const applyStartInfo = (agents: AgentMetadata[]) => {
    ;(store as unknown as { applyStartInfo(result: StartInfo, opts: { fresh: boolean }): void })
      .applyStartInfo({ version: '0', projectPath: '/repo', homePath: '/home', workspacePath: '/repo', agents } as StartInfo, { fresh: true })
  }
  return { settings, applyStartInfo }
}

describe('a host with one agent installed', () => {
  test('moves the saved default and the composer built from it onto the installed agent', () => {
    const draftRun = run('claude-code')
    const { settings, applyStartInfo } = lifecycleFor('claude-code', [draftRun])

    applyStartInfo([agent('claude-code', false), agent('codex', true)])

    expect(settings.activeAgent).toBe('codex')
    // Without this the first prompt of a fresh install runs an agent that is
    // not on the host.
    expect(draftRun.provider).toBe('codex')
    expect(draftRun.modelConfig).toEqual(CODEX_DEFAULT)
  })

  test('leaves a run alone when its agent is installed', () => {
    const draftRun = run('claude-code')
    const { settings, applyStartInfo } = lifecycleFor('claude-code', [draftRun])

    applyStartInfo([agent('claude-code', true), agent('codex', true)])

    expect(settings.activeAgent).toBe('claude-code')
    expect(draftRun.provider).toBe('claude-code')
  })

  test('leaves everything alone when nothing is installed, so the demotion never invents an agent', () => {
    const draftRun = run('claude-code')
    const { settings, applyStartInfo } = lifecycleFor('claude-code', [draftRun])

    applyStartInfo([agent('claude-code', false), agent('codex', false)])

    expect(settings.activeAgent).toBe('claude-code')
    expect(draftRun.provider).toBe('claude-code')
  })

  test('a run with no agent of its own reads the demoted setting at send', () => {
    const draftRun = run(null)
    const { settings, applyStartInfo } = lifecycleFor('claude-code', [draftRun])

    applyStartInfo([agent('claude-code', false), agent('codex', true)])

    expect(settings.activeAgent).toBe('codex')
    expect(draftRun.provider).toBeNull()
  })
})

describe('the agent a new automation is created on', () => {
  test('honors a pinned agent the host can run', () => {
    const agents = [agent('claude-code', true), agent('codex', true)]
    expect(runnableAutomationAgent(agents, 'codex')).toBe('codex')
  })

  test('drops a pinned agent the host cannot run, so the automation is not saved unrunnable', () => {
    const agents = [agent('claude-code', true), agent('codex', false)]
    expect(runnableAutomationAgent(agents, 'codex')).toBe('claude-code')
  })

  test('picks the installed agent when nothing is pinned', () => {
    const agents = [agent('claude-code', false), agent('codex', true)]
    expect(runnableAutomationAgent(agents, undefined)).toBe('codex')
  })

  test('never offers an agent with no headless runner', () => {
    const agents = [agent('opencode', true), agent('codex', true)]
    expect(runnableAutomationAgent(agents, 'opencode')).toBe('codex')
  })
})

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { ExecutionPreferences } from '@solus/contracts/settings'
import type { IpcContext } from '@solus/contracts/types'
import type { SessionRunRequest } from '@solus/server/execution/session-runtime'
import type { ActingScope } from '@solus/server/vault/acting-scope'

// bun has no node:sqlite; the indexer's import chain reaches it.
mock.module('node:sqlite', () => ({ DatabaseSync }))

// docs/plans/host-preferences.md: a host reads a person's execution preferences
// from its own copy of them, which their clients write. A request carries only
// the session and what the person chose for it. So a client that knows a
// preference the host does not know still works, and one person's preferences
// never run another person's work.

let dataDir: string
let closeDb: () => void
let acting: typeof import('@solus/server/vault/acting-scope')
let preferencesModule: typeof import('@solus/server/execution/person-preferences')
let hostScope: ActingScope

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-host-preferences-'))
  process.env.SOLUS_DATA_DIR = dataDir
  ;({ closeDb } = await import('@solus/server/db'))
  acting = await import('@solus/server/vault/acting-scope')
  preferencesModule = await import('@solus/server/execution/person-preferences')
  ;({ HOST_SCOPE: hostScope } = await import('@solus/server/execution/seats/acting-identity'))
})

afterEach(() => preferencesModule.resetPersonPreferencesForTests())

afterAll(() => {
  closeDb?.()
  rmSync(dataDir, { recursive: true, force: true })
})

/** A call made by one person: their scope, as the RPC edge sets it. */
function as<T>(personKey: string, call: () => T): T {
  return acting.withActingScope({ ...hostScope, personKey }, call)
}

/** The host's `executionPreferencesSet` handler, as a client reaches it. */
async function preferencesHandler() {
  const { registerSettingsHandlers } = await import('@solus/server/transport/handlers/settings-handlers')
  const handlers = new Map<string, (args: unknown[]) => unknown>()
  const server = { register: (name: string, handler: (args: unknown[]) => unknown) => handlers.set(name, handler) }
  registerSettingsHandlers(server as never, { sessionRuntime: {} as never, onHostConfigChanged: () => {}, onProviderInstancesChanged: () => {} })
  return (preferences: object) => handlers.get('executionPreferencesSet')!([preferences])
}

async function dispatchWithRuns() {
  const { PromptDispatch } = await import('@solus/server/execution/sessions/prompt-dispatch')
  const runs: SessionRunRequest[] = []
  const rt = {
    activeSessions: new Map(),
    agentSessionToSession: new Map(),
    assertNewWorkAllowed: () => {},
    seatForTurn: async () => null,
    sessionOfThread: () => undefined,
    history: { loadSessionPage: async () => ({ messages: [] }) },
    runTurn: async (request: SessionRunRequest) => {
      runs.push(request)
      return { disposition: 'started', agentSessionId: Promise.resolve({ agentSessionId: 'thread' }), done: Promise.resolve({}), cancel: () => {} }
    },
  }
  return { dispatch: new PromptDispatch(rt as never), runs }
}

/** A prompt's context as a client sends it now: the session and the composer's choices, no settings. */
function promptContext(sessionId: string): IpcContext {
  return {
    session: {
      sessionId, provider: 'codex', agentSessionId: null, status: 'idle', workingDirectory: dataDir, projectPath: dataDir, codebaseId: null,
      gitContext: null, worktreeBaseBranch: null, worktreeRepositories: null, preferredModel: 'gpt-5.5', reasoningEffort: 'medium', contextWindow: null,
      fastMode: false, permissionMode: 'supervised', readOnlyReason: null,
    },
    statusBar: {
      workingDirectory: dataDir, activeAgent: 'codex', permissionMode: 'supervised', model: 'gpt-5.5', reasoningEffort: 'medium',
      defaultReasoningEffort: 'medium', reasoningLevels: [], supportsFastMode: false, fastMode: false, contextWindows: [],
    },
  }
}

describe("a host keeps its own copy of each person's preferences", () => {
  test('a client that knows a preference this host does not know writes its copy, and the prompt still runs', async () => {
    const write = await preferencesHandler()
    // A newer client: one key this host has never heard of, and one value it does not accept.
    const answer = await as('person-a', () => write({ extraInstructions: 'Answer in French.', rateLimitBehavior: 'later', newerPreference: true }))
    expect(answer).toEqual({ ignored: ['newerPreference', 'rateLimitBehavior'] })

    const { dispatch, runs } = await dispatchWithRuns()
    await as('person-a', () => dispatch.submitPrompt(promptContext('session-a'), { prompt: 'Go.' }))
    expect(runs).toHaveLength(1)
    expect(runs[0]!.input.extraInstructions).toBe('Answer in French.')
    // The value it did not accept reads as the built-in default.
    expect(runs[0]!.input.rateLimitBehavior).toBe('ask')
  })

  test("each person's work runs with their own copy, and a later write changes the next run", async () => {
    const write = await preferencesHandler()
    await as('person-a', () => write({ extraInstructions: 'Mine.' } satisfies ExecutionPreferences))
    await as('person-b', () => write({ extraInstructions: 'Theirs.' } satisfies ExecutionPreferences))
    const { dispatch, runs } = await dispatchWithRuns()

    await as('person-b', () => dispatch.submitPrompt(promptContext('session-b'), { prompt: 'One.' }))
    await as('person-a', () => write({ extraInstructions: 'Mine, changed.' } satisfies ExecutionPreferences))
    await as('person-a', () => dispatch.submitPrompt(promptContext('session-a2'), { prompt: 'Two.' }))
    // A person with no copy yet runs with the built-in defaults, never somebody else's.
    await as('person-c', () => dispatch.submitPrompt(promptContext('session-c'), { prompt: 'Three.' }))

    expect(runs.map((run) => run.input.extraInstructions)).toEqual(['Theirs.', 'Mine, changed.', ''])
  })

  test("the host's own work has no person and keeps no copy", async () => {
    const write = await preferencesHandler()
    expect(() => acting.withActingScope(hostScope, () => write({ extraInstructions: 'Nobody.' }))).toThrow('Only a person has preferences.')
    expect(acting.withActingScope(hostScope, () => preferencesModule.actingPreferences(undefined))).toEqual({})
  })
})

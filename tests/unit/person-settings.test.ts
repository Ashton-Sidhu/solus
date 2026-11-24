import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { HostPersonalSettings, PersonalSettingsPatch, PersonalSettingsPatchResult } from '@solus/contracts/settings'
import type { IpcContext } from '@solus/contracts/types'
import type { SessionRunRequest } from '@solus/server/execution/session-runtime'
import type { PersonSettingsAccount } from '@solus/server/execution/person-settings'
import type { ActingScope } from '@solus/server/vault/acting-scope'

// bun has no node:sqlite; the indexer's import chain reaches it.
mock.module('node:sqlite', () => ({ DatabaseSync }))

// ADR 0007, docs/plans/personal-settings-source.md: signed out, a host's database
// is the source of a person's settings; signed in, the account is, and the host
// keeps the last copy it pulled. A request carries only the session and what the
// person chose for it. A key the host does not know never fails a call.

let root: string
let acting: typeof import('@solus/server/vault/acting-scope')
let settingsModule: typeof import('@solus/server/execution/person-settings')
let hostScope: ActingScope
const previousDataDir = process.env.SOLUS_DATA_DIR

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'solus-person-settings-'))
  useHost('host-a')
  acting = await import('@solus/server/vault/acting-scope')
  settingsModule = await import('@solus/server/execution/person-settings')
  ;({ HOST_SCOPE: hostScope } = await import('@solus/server/execution/seats/acting-identity'))
})

afterEach(async () => {
  settingsModule.usePersonSettingsAccount(null)
  await closeHost()
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  useHost('host-a')
  settingsModule.resetPersonSettingsForTests()
})

afterAll(async () => {
  await closeHost()
  rmSync(root, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

/** Each host has its own data folder, so its own database. */
function useHost(name: string): void {
  const dataDir = join(root, name)
  mkdirSync(dataDir, { recursive: true })
  process.env.SOLUS_DATA_DIR = dataDir
}

async function closeHost(): Promise<void> {
  await settingsModule?.personSettingsWritten()
  const [{ closeDb }, { closeDatabase }] = await Promise.all([import('@solus/server/db'), import('@solus/server/db/database')])
  await closeDatabase()
  closeDb()
}

/** The host process stops, and a process starts on `name`'s data folder: only its database is left. */
async function restartOn(name: string): Promise<void> {
  await closeHost()
  useHost(name)
  settingsModule.resetPersonSettingsForTests()
  await settingsModule.loadPersonSettings()
}

/** A call made by one person: their scope, as the RPC edge sets it. */
function as<T>(personKey: string, call: () => T): T {
  return acting.withActingScope({ ...hostScope, personKey }, call)
}

/** The host's settings handlers, as a client reaches them. */
async function settingsHandlers() {
  const { registerSettingsHandlers } = await import('@solus/server/transport/handlers/settings-handlers')
  const handlers = new Map<string, (args: unknown[]) => unknown>()
  const server = { register: (name: string, handler: (args: unknown[]) => unknown) => handlers.set(name, handler) }
  registerSettingsHandlers(server as never, { sessionRuntime: {} as never, onHostConfigChanged: () => {}, onProviderInstancesChanged: () => {} })
  return {
    get: () => handlers.get('personalSettingsGet')!([]) as HostPersonalSettings,
    // A newer client may send what this host's types do not name.
    patch: (change: PersonalSettingsPatch | { set: object; reset?: string[] }) => handlers.get('personalSettingsPatch')!([change]) as Promise<PersonalSettingsPatchResult>,
    changed: () => handlers.get('personalSettingsChanged')!([]) as Promise<HostPersonalSettings>,
    syncSet: (syncSettings: boolean) => handlers.get('personalSettingsSyncSet')!([syncSettings]) as Promise<HostPersonalSettings>,
  }
}

/** An account that answers what `answers` holds now, for the people `tokens` names. */
function fakeAccount(tokens: Record<string, string>, answers: Map<string, () => Response | { refused: 'NOT_LINKED' | 'NO_DELEGATION' | 'UNREACHABLE'; message: string }>): PersonSettingsAccount & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    userFor: (personKey) => tokens[personKey] ?? null,
    read: async (userId) => {
      reads.push(userId)
      return answers.get(userId)?.() ?? { refused: 'UNREACHABLE', message: 'no answer' }
    },
  }
}

function accountAnswer(revision: number | null, settings: object): Response {
  return Response.json({ schemaVersion: 1, generation: 0, revision, settings, updatedAt: revision === null ? null : 1 })
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
  const dataDir = process.env.SOLUS_DATA_DIR!
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

describe("a host keeps each person's settings", () => {
  test('a client that knows a setting this host does not know writes it, and the prompt still runs', async () => {
    // WHY: ADR 0007 decision 7. A client newer than its host must never make a call fail.
    const host = await settingsHandlers()
    const answer = await as('person-a', () => host.patch({ set: { extraInstructions: 'Answer in French.', rateLimitBehavior: 'later', newerSetting: true }, reset: ['olderSetting'] }))
    expect(answer.ignored).toEqual(['newerSetting', 'olderSetting', 'rateLimitBehavior'])
    expect(answer.settings).toMatchObject({ settings: { extraInstructions: 'Answer in French.' }, source: 'host', followsAccount: false })

    const { dispatch, runs } = await dispatchWithRuns()
    await as('person-a', () => dispatch.submitPrompt(promptContext('session-a'), { prompt: 'Go.' }))
    expect(runs).toHaveLength(1)
    expect(runs[0]!.input.extraInstructions).toBe('Answer in French.')
    // The value it did not accept reads as the built-in default.
    expect(runs[0]!.input.rateLimitBehavior).toBe('ask')
  })

  test("each person's work runs with their own settings, and a later change reaches the next run", async () => {
    const host = await settingsHandlers()
    await as('person-a', () => host.patch({ set: { extraInstructions: 'Mine.' }, reset: [] }))
    await as('person-b', () => host.patch({ set: { extraInstructions: 'Theirs.', themeMode: 'dark' }, reset: [] }))
    const { dispatch, runs } = await dispatchWithRuns()

    await as('person-b', () => dispatch.submitPrompt(promptContext('session-b'), { prompt: 'One.' }))
    await as('person-a', () => host.patch({ set: { extraInstructions: 'Mine, changed.' }, reset: [] }))
    await as('person-a', () => dispatch.submitPrompt(promptContext('session-a2'), { prompt: 'Two.' }))
    // A person with no settings here yet runs with the built-in defaults, never somebody else's.
    await as('person-c', () => dispatch.submitPrompt(promptContext('session-c'), { prompt: 'Three.' }))

    expect(runs.map((run) => run.input.extraInstructions)).toEqual(['Theirs.', 'Mine, changed.', ''])
    // A reset returns a key to its default; the other keys stay.
    await as('person-b', () => host.patch({ set: {}, reset: ['extraInstructions'] }))
    expect(as('person-b', () => host.get()).settings).toEqual({ themeMode: 'dark' })
  })

  test("the host's own work has no person and keeps no settings", async () => {
    const host = await settingsHandlers()
    expect(() => acting.withActingScope(hostScope, () => host.get())).toThrow('Only a person has settings.')
    expect(acting.withActingScope(hostScope, () => settingsModule.actingPreferences(undefined))).toEqual({})
  })

  test("a signed-out person's settings survive a host restart", async () => {
    // WHY: ADR 0007 decision 2. The host's database is the source while signed out; nothing waits for a client to send them again.
    const host = await settingsHandlers()
    await as('person-a', () => host.patch({ set: { themeMode: 'dark', extraInstructions: 'Be brief.' }, reset: [] }))
    await restartOn('host-a')
    expect(as('person-a', () => host.get())).toMatchObject({ settings: { themeMode: 'dark', extraInstructions: 'Be brief.' }, source: 'host' })
    expect(as('person-a', () => settingsModule.actingPreferences(undefined)).extraInstructions).toBe('Be brief.')
  })

  test('two hosts keep separate settings for one signed-out person', async () => {
    // WHY: ADR 0007 decision 2. A change on one host stays on that host.
    const host = await settingsHandlers()
    await as('person-a', () => host.patch({ set: { extraInstructions: 'On A.' }, reset: [] }))
    await restartOn('host-b')
    expect(as('person-a', () => host.get()).settings).toEqual({})
    await as('person-a', () => host.patch({ set: { extraInstructions: 'On B.' }, reset: [] }))
    await restartOn('host-a')
    expect(as('person-a', () => host.get()).settings).toEqual({ extraInstructions: 'On A.' })
    await restartOn('host-b')
    expect(as('person-a', () => host.get()).settings).toEqual({ extraInstructions: 'On B.' })
  })
})

describe("a person's Sync settings switch on a host", () => {
  test('it is on before the person chooses, keeps their choice across a restart, and is their own', async () => {
    // WHY: docs/plans/settings-sync-hosts.md decision 2. The switch is on the host, so
    // each client of the person shows the same choice, and a restart does not undo it.
    const host = await settingsHandlers()
    expect(as('person-a', () => host.get()).syncSettings).toBe(true)
    const answer = await as('person-a', () => host.syncSet(false))
    expect(answer.syncSettings).toBe(false)
    await restartOn('host-a')
    expect(as('person-a', () => host.get()).syncSettings).toBe(false)
    expect(as('person-b', () => host.get()).syncSettings).toBe(true)
  })

  test('turning it off or on changes no setting', async () => {
    // WHY: the switch says which hosts take a change; a host with it off keeps its own settings.
    const host = await settingsHandlers()
    await as('person-a', () => host.patch({ set: { themeMode: 'dark' }, reset: [] }))
    await as('person-a', () => host.syncSet(false))
    await as('person-a', () => host.syncSet(true))
    expect(as('person-a', () => host.get()).settings).toEqual({ themeMode: 'dark' })
  })
})

describe("a signed-in person's settings come from the account", () => {
  test('the host pulls them, and keeps them when the cloud does not answer and after a restart', async () => {
    // WHY: ADR 0007 decision 4. The host follows the account by pull and keeps the last copy for restarts and an outage.
    const answers = new Map<string, () => Response | { refused: 'UNREACHABLE'; message: string }>()
    answers.set('ada', () => accountAnswer(3, { extraInstructions: 'From the account.', themeMode: 'light' }))
    const account = fakeAccount({ 'person-ada': 'ada' }, answers)
    settingsModule.usePersonSettingsAccount(account)
    const host = await settingsHandlers()
    // A copy the person wrote here before they signed in.
    await as('person-ada', () => host.patch({ set: { extraInstructions: 'Old, on the host.' }, reset: [] }))

    const pulled = await as('person-ada', () => host.changed())
    expect(pulled).toEqual({ settings: { extraInstructions: 'From the account.', themeMode: 'light' }, source: 'account', followsAccount: true, accountRevision: 3, updatedAt: expect.any(Number), syncSettings: true })

    answers.set('ada', () => ({ refused: 'UNREACHABLE', message: 'Solus Cloud is unreachable.' }))
    await as('person-ada', () => host.changed())
    await settingsModule.pullPersonSettings('person-ada')
    await restartOn('host-a')
    settingsModule.usePersonSettingsAccount(account)
    expect(as('person-ada', () => host.get())).toMatchObject({ settings: { extraInstructions: 'From the account.' }, source: 'account', accountRevision: 3 })
    const { dispatch, runs } = await dispatchWithRuns()
    await as('person-ada', () => dispatch.submitPrompt(promptContext('session-ada'), { prompt: 'Go.' }))
    expect(runs[0]!.input.extraInstructions).toBe('From the account.')
  })

  test('the periodic pull reaches a person no client nudged', async () => {
    const answers = new Map([['ada', () => accountAnswer(1, { extraInstructions: 'Pulled.' })]])
    settingsModule.usePersonSettingsAccount(fakeAccount({ 'person-ada': 'ada' }, answers))
    const stop = settingsModule.startPersonSettingsPulls(() => ['person-ada'], 60_000)
    stop()
    await settingsModule.personSettingsWritten()
    // The sweep at the start is asynchronous: wait for its read and write.
    for (let attempt = 0; attempt < 20 && as('person-ada', () => settingsModule.actingPersonalSettings()).source !== 'account'; attempt += 1) await Bun.sleep(5)
    expect(as('person-ada', () => settingsModule.actingPersonalSettings()).settings).toEqual({ extraInstructions: 'Pulled.' })
  })

  test('a key the account holds and this host does not know never fails the pull', async () => {
    const answers = new Map([['ada', () => accountAnswer(2, { extraInstructions: 'Kept.', newerSetting: { on: true }, fontSize: 'huge' })]])
    settingsModule.usePersonSettingsAccount(fakeAccount({ 'person-ada': 'ada' }, answers))
    const host = await settingsHandlers()
    expect((await as('person-ada', () => host.changed())).settings).toEqual({ extraInstructions: 'Kept.' })
  })

  test('an account with no document leaves the host copy as it is', async () => {
    // WHY: at the first sign-in the client seeds the account from the host copy; until then the host keeps it.
    const answers = new Map([['ada', () => accountAnswer(null, {})]])
    settingsModule.usePersonSettingsAccount(fakeAccount({ 'person-ada': 'ada' }, answers))
    const host = await settingsHandlers()
    await as('person-ada', () => host.patch({ set: { extraInstructions: 'Mine.' }, reset: [] }))
    expect(await as('person-ada', () => host.changed())).toMatchObject({ settings: { extraInstructions: 'Mine.' }, source: 'host', followsAccount: true })
  })

  test('a host with no token for the person takes the settings from their client', async () => {
    // WHY: ADR 0007 decision 5. With no token the host cannot pull, so it says so, and the client writes the account copy.
    const account = fakeAccount({}, new Map())
    settingsModule.usePersonSettingsAccount(account)
    const host = await settingsHandlers()
    const nudged = await as('person-bob', () => host.changed())
    expect(nudged).toMatchObject({ followsAccount: false, settings: {} })
    expect(account.reads).toEqual([])
    const written = await as('person-bob', () => host.patch({ set: { extraInstructions: 'From the client.' }, reset: [] }))
    expect(written.settings).toMatchObject({ settings: { extraInstructions: 'From the client.' }, source: 'host', followsAccount: false })
    expect(as('person-bob', () => settingsModule.actingPreferences(undefined)).extraInstructions).toBe('From the client.')
  })
})

describe("a signed-out person's agent profile list on a host", () => {
  test('the host keeps it for that person only, across a restart, and leaves out an entry it cannot read', async () => {
    // WHY: ADR 0007 decision 6. The agent profile follows the settings' rule; a newer client never makes a call fail.
    const documents = await import('@solus/server/execution/seats/agent-profile-document')
    const deploy = { kind: 'skill' as const, name: 'deploy', source: 'acme/skills', skillId: 'deploy' }
    const written = await as('person-a', () => documents.patchActingAgentProfileDocument({
      // SAFETY: a newer client's entry kind, which this host's types do not name.
      set: { 'skill:deploy': deploy, 'widget:new': { kind: 'widget' } as never },
      reset: [],
    }))
    expect(written.entries).toEqual({ 'skill:deploy': deploy })
    await restartOn('host-a')
    expect((await as('person-a', () => documents.actingAgentProfileDocument())).entries).toEqual({ 'skill:deploy': deploy })
    expect((await as('person-b', () => documents.actingAgentProfileDocument())).entries).toEqual({})
    await as('person-a', () => documents.patchActingAgentProfileDocument({ set: {}, reset: ['skill:deploy'] }))
    expect((await as('person-a', () => documents.actingAgentProfileDocument())).entries).toEqual({})
  })
})


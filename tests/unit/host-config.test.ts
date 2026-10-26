import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_HOST_CONFIG, hostConfigPatchSchema, mergeHostConfig, type HostConfigSnapshot } from '@solus/contracts/host-config'
import type { DeviceSettingsState } from '@solus/contracts/device-types'
import { createHash } from 'node:crypto'
import type { AgentDeviceSettings, AgentPersonalRequest } from '@solus/contracts/agent-personal-request'
import type { AgentProfile } from '@solus/contracts/agent-profile'
import type { PersonalSettingsDocument } from '@solus/contracts/settings'
import { summarizeAgentProfile } from '@solus/client-core/agent-personal-requests'

// A disposable data dir: these tests persist host config, and the live ~/.solus
// holds the developer's real settings.
// The agent tool reads a session's organization from its record, so loading it opens the database module.
mock.module('node:sqlite', () => ({ DatabaseSync }))

type SettingsModule = typeof import('@solus/server/host/settings')
type RunInputModule = typeof import('@solus/server/execution/agents/run-input')
type AgentToolModule = typeof import('@solus/server/execution/agents/tools/agent-tool')

/** The real call path, so these exercise the tools' own argument validation
 *  rather than a shape the provider would never actually send. */
let runTool: AgentToolModule['executeAgentTool']

const context = {
  provider: 'claude-code' as const,
  cwd: '/tmp',
  sessionId: () => undefined,
  abortSignal: new AbortController().signal,
  parentToolUseId: () => undefined,
  emit: () => {},
}

const previousDataDir = process.env.SOLUS_DATA_DIR
let dataDir: string
let settings: SettingsModule
let runInput: RunInputModule

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'solus-host-config-'))
  process.env.SOLUS_DATA_DIR = dataDir
  settings = await import('@solus/server/host/settings')
  runInput = await import('@solus/server/execution/agents/run-input')
  ;({ executeAgentTool: runTool } = await import('@solus/server/execution/agents/tools/agent-tool'))
})

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

/** The `configUpdate` RPC handler as the server registers it, with the broadcasts it makes. */
async function configUpdateHandler() {
  const { registerSettingsHandlers } = await import('@solus/server/transport/handlers/settings-handlers')
  const handlers = new Map<string, (args: unknown[]) => Promise<HostConfigSnapshot>>()
  const broadcasts: HostConfigSnapshot[] = []
  const server = { register: (name: string, handler: (args: unknown[]) => Promise<HostConfigSnapshot>) => handlers.set(name, handler) }
  registerSettingsHandlers(server as never, { sessionRuntime: {} as never, onHostConfigChanged: (snapshot) => broadcasts.push(snapshot) })
  return { update: (patch: object) => handlers.get('configUpdate')!([patch]), broadcasts }
}

describe('host config', () => {
  test('holds only what the host owns', () => {
    // A person's choices are personal settings (plans/018), never host config.
    expect(Object.keys(DEFAULT_HOST_CONFIG).sort()).toEqual([
      'analyticsEnabled',
      'archivedAutomationRetentionDays',
      'continueSessionsAfterHostRestart',
      'otel',
      'reviewWarmingByProject',
      'solusTools',
      'unfiledRecordingRetentionDays',
    ])
  })

  test('a patch changes only the keys it carries', () => {
    settings.setHostConfig({ archivedAutomationRetentionDays: 12, continueSessionsAfterHostRestart: false })
    const next = settings.setHostConfig({ archivedAutomationRetentionDays: 20 })

    expect(next.config.archivedAutomationRetentionDays).toBe(20)
    // A patch that reset unmentioned keys would lose an operator's choice every
    // time an unrelated toggle moved.
    expect(next.config.continueSessionsAfterHostRestart).toBe(false)
    settings.setHostConfig({ continueSessionsAfterHostRestart: true })
  })

  test('a patch with a key the host does not own is refused, not dropped', () => {
    // A personal or device key has no place on a host. Dropping it silently
    // would tell the client its choice was saved.
    expect(hostConfigPatchSchema.safeParse({ themeMode: 'dark' }).success).toBe(false)
    expect(hostConfigPatchSchema.safeParse({ remoteAccess: true }).success).toBe(false)
    expect(hostConfigPatchSchema.safeParse({ archivedAutomationRetentionDays: 7 }).success).toBe(true)
  })

  test('the host analytics consent is a host key', () => {
    expect(DEFAULT_HOST_CONFIG.analyticsEnabled).toBe(true)
    expect(settings.setHostConfig({ analyticsEnabled: false }).config.analyticsEnabled).toBe(false)
    settings.setHostConfig({ analyticsEnabled: true })
  })

  test('config survives a host restart', () => {
    settings.setHostConfig({ archivedAutomationRetentionDays: 45, reviewWarmingByProject: { '/repo': true } })

    const persisted = JSON.parse(readFileSync(join(dataDir, 'server-settings.json'), 'utf-8'))
    expect(persisted.hostConfig.archivedAutomationRetentionDays).toBe(45)
    expect(persisted.hostConfig.reviewWarmingByProject).toEqual({ '/repo': true })
  })
})

describe('the configUpdate RPC', () => {
  test('stores a host patch and broadcasts it', async () => {
    const { update, broadcasts } = await configUpdateHandler()
    const snapshot = await update({ archivedAutomationRetentionDays: 33 })

    expect(snapshot.config.archivedAutomationRetentionDays).toBe(33)
    expect(broadcasts.at(-1)?.config.archivedAutomationRetentionDays).toBe(33)
  })

  test('refuses a patch that carries a personal key, names it, and changes nothing', async () => {
    const { update, broadcasts } = await configUpdateHandler()
    const before = settings.getHostConfig().config

    const refused = update({ archivedAutomationRetentionDays: 3, extraInstructions: 'mine' })
    await expect(refused).rejects.toThrow('Host config refused')
    await expect(update({ themeMode: 'dark' })).rejects.toThrow('themeMode')
    expect(settings.getHostConfig().config).toEqual(before)
    expect(broadcasts).toHaveLength(0)
  })
})

describe('instructions on runs with no renderer', () => {
  test('a server-originated run carries the instructions captured for its person', () => {
    // Instructions are the person's (plans/018 §3.1). A run Solus starts for
    // them — an automation, an agent-created session, a handoff, a background
    // review — carries the instructions captured with their preferences.
    const preferences = { extraInstructions: 'Answer in Simplified Technical English.' }
    expect(runInput.instructionsFor(preferences, 'claude-opus-4').extraInstructions)
      .toBe('Answer in Simplified Technical English.')
  })

  test('work no person describes runs with no instructions', () => {
    expect(runInput.instructionsFor(undefined, 'claude-opus-4').extraInstructions).toBe('')
  })

  test('model instructions are resolved for the model actually running', () => {
    const preferences = { modelInstructions: { 'gpt-5.6-luna': 'Prefer short answers.', 'claude-opus-4': 'Show your work.' } }

    expect(runInput.instructionsFor(preferences, 'gpt-5.6-luna').modelInstructions).toBe('Prefer short answers.')
    // A model with nothing scoped to it gets nothing, not another model's text.
    expect(runInput.instructionsFor(preferences, 'some-other-model').modelInstructions).toBeUndefined()
  })

})

describe('the agent write policy', () => {
  /** The person's settings as their connected client holds them; `null` is no client connected. */
  let personal: PersonalSettingsDocument | null
  let profile: AgentProfile
  let personalRequests: AgentPersonalRequest[]
  let deviceSettings: DeviceSettingsState
  /** The turn's client device, as it answers; `turnClientAnswers` false is another of the person's clients answering. */
  let device: AgentDeviceSettings
  let turnClientAnswers: boolean
  let broadcasts: HostConfigSnapshot[]

  beforeEach(async () => {
    personal = {}
    profile = {}
    personalRequests = []
    deviceSettings = { enabled: true, agentAccessEnabled: false, onboardingCompleted: true, autoShowAgentDevices: true, sshHosts: [] }
    device = {
      voiceModeEnabled: false, autoSendVoiceTranscripts: false, vadSilenceMs: 1500, defaultEditor: 'vim', fallbackTerminal: 'default-terminal',
      fontSmoothing: true, clientAnalyticsEnabled: null, fontFamilyOverride: null, codeFontFamilyOverride: null, documentFontFamilyOverride: null,
      promptFontFamilyOverride: null, zoomFactor: 1, keybindings: {},
    }
    turnClientAnswers = true
    broadcasts = []
    const tools = await import('@solus/server/execution/agents/tools/config-tools')
    tools.setConfigToolHost({
      hostConfigChanged: (snapshot) => { broadcasts.push(snapshot) },
      deviceManager: {
        settings: () => deviceSettings,
        configure: async (request) => {
          deviceSettings = { ...deviceSettings, ...request }
          return { settings: deviceSettings } as never
        },
        saveSshHosts: async (sshHosts) => {
          deviceSettings = { ...deviceSettings, sshHosts }
          return { settings: deviceSettings } as never
        },
      },
      personal: async (_sessionId, request) => {
        personalRequests.push(request)
        if (!personal) return { reply: { ok: false, error: 'No Solus client of this person is connected to this host.' }, fromTurnClient: false }
        if (request.device && !turnClientAnswers) return { reply: { ok: false, error: 'The Solus client that started this turn is not connected.' }, fromTurnClient: false }
        if (request.settings) personal = { ...personal, ...request.settings }
        if (request.profile) {
          profile = { ...profile, ...request.profile.set }
          for (const key of request.profile.reset) delete profile[key]
        }
        if (request.device) device = { ...device, ...request.device }
        return { reply: { ok: true, settings: personal, profile: summarizeAgentProfile(profile), device }, fromTurnClient: turnClientAnswers }
      },
    })
    // A tool choice merges key by key, so the one a test turns off is turned back on here.
    settings.setHostConfig({ continueSessionsAfterHostRestart: true, analyticsEnabled: true, solusTools: { read_work: true } })
  })

  test('an agent can set any host key it is shown, and every client hears it', async () => {
    const tools = await import('@solus/server/execution/agents/tools/config-tools')
    const result = await runTool(tools.updateConfigAgentTool, {
      host: { continueSessionsAfterHostRestart: false, archivedAutomationRetentionDays: 7, analyticsEnabled: false, solusTools: { read_work: false } },
    }, context)

    expect(result.ok).toBe(true)
    const config = settings.getHostConfig().config
    expect(config.continueSessionsAfterHostRestart).toBe(false)
    expect(config.archivedAutomationRetentionDays).toBe(7)
    expect(config.analyticsEnabled).toBe(false)
    expect(config.solusTools.read_work).toBe(false)
    expect(broadcasts.at(-1)?.config.analyticsEnabled).toBe(false)
    settings.setHostConfig({ solusTools: { read_work: true } })
  })

  test('a host key the agent did not name keeps its value', async () => {
    // The listed schema is parsed first; a healing default in it would reset
    // every key it fills, and wipe the review warming the person chose.
    const tools = await import('@solus/server/execution/agents/tools/config-tools')
    settings.setHostConfig({ analyticsEnabled: false, reviewWarmingByProject: { '/repo': true } })
    const result = await runTool(tools.updateConfigAgentTool, { host: { archivedAutomationRetentionDays: 9 } }, context)

    expect(result.ok).toBe(true)
    const config = settings.getHostConfig().config
    expect(config.archivedAutomationRetentionDays).toBe(9)
    expect(config.analyticsEnabled).toBe(false)
    expect(config.reviewWarmingByProject).toEqual({ '/repo': true })
    expect((await runTool(tools.updateConfigAgentTool, { host: {} }, context)).ok).toBe(false)
    settings.setHostConfig({ analyticsEnabled: true, reviewWarmingByProject: {} })
  })

  test('the collector credentials stay out of reach: otel cannot be written', async () => {
    const tools = await import('@solus/server/execution/agents/tools/config-tools')
    settings.setHostConfig({ otel: { endpoint: 'https://collector.example.com' } })
    const result = await runTool(tools.updateConfigAgentTool, { host: { otel: { endpoint: 'https://attacker.example.com' } } }, context)

    expect(result.ok).toBe(false)
    expect(settings.getHostConfig().config.otel.endpoint).toBe('https://collector.example.com')
  })

  test("a personal change goes to the person's client, never into the host config", async () => {
    // The host holds no person's settings (docs/settings.md). Their client
    // applies the change as a local edit, and its sync sends it on.
    const tools = await import('@solus/server/execution/agents/tools/config-tools')
    const before = settings.getHostConfig().config
    const result = await runTool(tools.updateConfigAgentTool, { personal: { reviewModel: 'gpt-6-luna', reviewReasoning: 'high' } }, context)

    expect(result.ok).toBe(true)
    expect(personal).toEqual({ reviewModel: 'gpt-6-luna', reviewReasoning: 'high' })
    expect(settings.getHostConfig().config).toEqual(before)
  })

  test('an agent may write instructions and the permission mode, with no approval step', async () => {
    // A product decision: agents configure every personal setting themselves.
    const tools = await import('@solus/server/execution/agents/tools/config-tools')
    expect(tools.updateConfigAgentTool.requiresApproval).toBe(false)
    const result = await runTool(tools.updateConfigAgentTool, {
      personal: { extraInstructions: 'Answer in short sentences.', defaultPermissionMode: 'plan' },
    }, context)

    expect(result.ok).toBe(true)
    expect(personal).toMatchObject({ extraInstructions: 'Answer in short sentences.', defaultPermissionMode: 'plan' })
  })

  test('an agent can set every device manager key, the SSH device hosts included', async () => {
    const tools = await import('@solus/server/execution/agents/tools/config-tools')
    const sshHost = { id: 'studio', label: 'Studio Mac', target: 'me@studio.local' }
    const result = await runTool(tools.updateConfigAgentTool, {
      deviceManager: { agentAccessEnabled: true, autoShowAgentDevices: false, sshHosts: [sshHost] },
    }, context)

    expect(result.ok).toBe(true)
    expect(deviceSettings).toMatchObject({ agentAccessEnabled: true, autoShowAgentDevices: false, sshHosts: [sshHost] })
  })

  test('device onboarding is what a client showed, not a setting, so an agent cannot set it', async () => {
    const tools = await import('@solus/server/execution/agents/tools/config-tools')
    deviceSettings.onboardingCompleted = false
    const result = await runTool(tools.updateConfigAgentTool, { deviceManager: { onboardingCompleted: true } }, context)

    expect(result.ok).toBe(false)
    expect(deviceSettings.onboardingCompleted).toBe(false)
  })

  test('a refused value blocks the whole change rather than applying half of it', async () => {
    // Half-applying would leave the agent reporting a change it did not fully
    // make, and the user with settings nobody chose.
    const tools = await import('@solus/server/execution/agents/tools/config-tools')
    const result = await runTool(tools.updateConfigAgentTool, {
      host: { continueSessionsAfterHostRestart: false },
      personal: { reviewModel: 'gpt-6-luna', reviewReasoning: 'enormous' },
    }, context)

    expect(result.ok).toBe(false)
    expect(result.text).toContain('reviewReasoning')
    expect(settings.getHostConfig().config.continueSessionsAfterHostRestart).toBe(true)
    expect(personalRequests).toEqual([])
  })

  test('with no client of the person connected, nothing changes and the agent is told why', async () => {
    const tools = await import('@solus/server/execution/agents/tools/config-tools')
    personal = null
    const result = await runTool(tools.updateConfigAgentTool, {
      host: { continueSessionsAfterHostRestart: false },
      personal: { reviewModel: 'gpt-6-luna' },
    }, context)

    expect(result.ok).toBe(false)
    expect(result.text).toContain('No Solus client')
    expect(settings.getHostConfig().config.continueSessionsAfterHostRestart).toBe(true)
  })

  test('an unknown key or an empty change comes back as a message, not a throw', async () => {
    const tools = await import('@solus/server/execution/agents/tools/config-tools')

    expect((await runTool(tools.updateConfigAgentTool, {}, context)).ok).toBe(false)
    expect((await runTool(tools.updateConfigAgentTool, { personal: {} }, context)).ok).toBe(false)
    expect((await runTool(tools.updateConfigAgentTool, { personal: { notASetting: true } }, context)).ok).toBe(false)
    expect((await runTool(tools.updateConfigAgentTool, { themeMode: 'light' }, context)).ok).toBe(false)
    expect(personalRequests).toEqual([])
  })

  test('read_config shows each section, with only the collector credentials withheld', async () => {
    const tools = await import('@solus/server/execution/agents/tools/config-tools')
    personal = { reviewModel: 'gpt-6-luna' }
    const result = await runTool(tools.readConfigAgentTool, {}, context)
    const payload = JSON.parse(result.text) as { host: object; deviceManager: object; personal: PersonalSettingsDocument; device: AgentDeviceSettings }

    expect(Object.keys(payload.host).sort()).toEqual([
      'analyticsEnabled',
      'archivedAutomationRetentionDays',
      'continueSessionsAfterHostRestart',
      'reviewWarmingByProject',
      'solusTools',
      'unfiledRecordingRetentionDays',
    ])
    expect(Object.keys(payload.deviceManager).sort()).toEqual(['agentAccessEnabled', 'autoShowAgentDevices', 'enabled', 'sshHosts'])
    expect(payload.device.zoomFactor).toBe(1)
    expect(payload.personal.reviewModel).toBe('gpt-6-luna')
  })

  test("an agent adds a subagent to the person's profile by its text; the host encodes and hashes it", async () => {
    const tools = await import('@solus/server/execution/agents/tools/config-tools')
    const text = '---\nname: reviewer\n---\nReview the diff.\n'
    const result = await runTool(tools.updateConfigAgentTool, {
      profile: { set: [{ kind: 'file', provider: 'claude-code', path: 'agents/reviewer.md', content: text }] },
    }, context)

    expect(result.ok).toBe(true)
    const entry = profile['file:claude-code/agents/reviewer.md']
    expect(entry?.kind === 'file' && Buffer.from(entry.contentBase64, 'base64').toString('utf8')).toBe(text)
    expect(entry?.kind === 'file' && entry.hash).toBe(createHash('sha256').update(text).digest('hex'))
  })

  test('skills and MCP servers are set, and entries removed, in one change', async () => {
    const tools = await import('@solus/server/execution/agents/tools/config-tools')
    profile = { 'skill:old': { kind: 'skill', name: 'old', source: 'acme/skills', skillId: 'old' } }
    const result = await runTool(tools.updateConfigAgentTool, {
      profile: {
        set: [
          { kind: 'skill', name: 'deploy', source: 'acme/skills', skillId: 'deploy' },
          { kind: 'integration', slug: 'deepwiki', name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp', auth: { kind: 'none' } },
        ],
        remove: ['skill:old'],
      },
    }, context)

    expect(result.ok).toBe(true)
    expect(Object.keys(profile).sort()).toEqual(['integration:deepwiki', 'skill:deploy'])
    expect(personalRequests).toHaveLength(1)
  })

  test('a file outside the profile folders is refused before the client is asked', async () => {
    // A home's CLAUDE.md is not part of the profile, and a path may not climb out of it.
    const tools = await import('@solus/server/execution/agents/tools/config-tools')
    for (const path of ['CLAUDE.md', 'agents/../../.ssh/config', 'skills']) {
      const result = await runTool(tools.updateConfigAgentTool, { profile: { set: [{ kind: 'file', provider: 'claude-code', path, content: 'x' }] } }, context)
      expect(result.ok).toBe(false)
    }
    expect(personalRequests).toEqual([])
  })

  test('read_config lists a profile file by path, size, and hash, never its content', async () => {
    const tools = await import('@solus/server/execution/agents/tools/config-tools')
    const content = Buffer.from('secret plan').toString('base64')
    profile = { 'file:codex/prompts/plan.md': { kind: 'file', provider: 'codex', path: 'prompts/plan.md', contentBase64: content, hash: 'a'.repeat(64) } }
    const result = await runTool(tools.readConfigAgentTool, {}, context)
    const payload = JSON.parse(result.text) as { profile: Record<string, { bytes?: number }> }

    expect(payload.profile['file:codex/prompts/plan.md']?.bytes).toBe('secret plan'.length)
    expect(result.text).not.toContain(content)
  })

  test("a device change applies on the turn's own client and is checked first", async () => {
    const tools = await import('@solus/server/execution/agents/tools/config-tools')
    const result = await runTool(tools.updateConfigAgentTool, {
      device: { zoomFactor: 1.25, defaultEditor: 'cursor', clientAnalyticsEnabled: false, keybindings: { 'composer.send': { code: 'Enter', mod: true } } },
    }, context)

    expect(result.ok).toBe(true)
    expect(device).toMatchObject({ zoomFactor: 1.25, defaultEditor: 'cursor', clientAnalyticsEnabled: false })
    expect((await runTool(tools.updateConfigAgentTool, { device: { zoomFactor: 9 } }, context)).ok).toBe(false)
    // Consent is set, never put back to undecided: only the person leaves it undecided.
    expect((await runTool(tools.updateConfigAgentTool, { device: { clientAnalyticsEnabled: null } }, context)).ok).toBe(false)
  })

  test("when another of the person's clients answers, read_config shows no device: it is another machine", async () => {
    const tools = await import('@solus/server/execution/agents/tools/config-tools')
    turnClientAnswers = false
    const payload = JSON.parse((await runTool(tools.readConfigAgentTool, {}, context)).text) as { device: { unavailable?: string } }
    expect(payload.device.unavailable).toContain('another client answered')

    const write = await runTool(tools.updateConfigAgentTool, { device: { zoomFactor: 1.5 } }, context)
    expect(write.ok).toBe(false)
    expect(device.zoomFactor).toBe(1)
  })

  test('both providers can list update_config with every settings key', async () => {
    // The owners' schemas heal and transform values, which the Claude SDK
    // cannot turn into JSON Schema; the tool lists their input side instead.
    const tools = await import('@solus/server/execution/agents/tools/config-tools')
    const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk')
    const { adaptCodexTools } = await import('@solus/server/execution/agents/codex/codex-tool-adapter')
    const agentTool = tools.updateConfigAgentTool
    const server = createSdkMcpServer({ name: 'solus', tools: [tool(agentTool.name, agentTool.description, agentTool.inputFields, async () => ({ content: [] }))] })
    // SAFETY: the SDK's in-process server is an MCP `McpServer`; its request handler map is how a client's tools/list reaches it.
    const handlers = (server as unknown as { instance: { server: { _requestHandlers: Map<string, (request: object, extra: object) => Promise<{ tools: Array<{ inputSchema: { properties: { personal: { properties: object } } } }> }>> } } }).instance.server._requestHandlers
    const listed = await handlers.get('tools/list')!({ method: 'tools/list', params: {} }, {})

    expect(Object.keys(listed.tools[0]!.inputSchema.properties.personal.properties)).toContain('extraInstructions')
    expect(JSON.stringify(adaptCodexTools([agentTool]))).toContain('sshHosts')
  })

  test('the agent sees what a setting means, not only its name and type', async () => {
    // About seventy keys reach an agent, and names such as tabGroupMode do not say
    // what they change. The owner schemas describe them; the listed schema keeps it.
    const tools = await import('@solus/server/execution/agents/tools/config-tools')
    const { adaptCodexTools } = await import('@solus/server/execution/agents/codex/codex-tool-adapter')
    const listed = JSON.stringify(adaptCodexTools([tools.updateConfigAgentTool]))
    for (const meaning of [
      'The order that the next-tab and previous-tab keys follow', // personal.tabGroupMode
      'the maximum of earlier conversation it takes, in tokens', // personal.handoffHistoryTokens
      'What agents can do to the status of a task', // personal.agentTaskLifecyclePolicy
      'By project path on this host', // host.reviewWarmingByProject
      'shows next to the conversation of that agent', // deviceManager.autoShowAgentDevices
      'Shortcut overrides by binding id', // device.keybindings
    ]) expect(listed).toContain(meaning)
  })
})

describe('nested keys', () => {
  test('toggling one otel switch does not blank the endpoint beside it', () => {
    // The Telemetry panel edits one field at a time. A patch that replaced the
    // whole object would lose whatever the user typed a moment earlier.
    settings.setHostConfig({ otel: { endpoint: 'https://collector.example.com', enabled: true } })
    const after = settings.setHostConfig({ otel: { exportTraces: false } }).config.otel

    expect(after.endpoint).toBe('https://collector.example.com')
    expect(after.enabled).toBe(true)
    expect(after.exportTraces).toBe(false)
  })

  test('an agent is never shown the collector credentials', async () => {
    const tools = await import('@solus/server/execution/agents/tools/config-tools')
    settings.setHostConfig({ otel: { endpoint: 'https://collector.example.com', headers: 'authorization=secret' } })

    const payload = JSON.parse((await runTool(tools.readConfigAgentTool, {}, context)).text) as {
      host: object
      withheldKeys: { host: string[] }
    }

    expect('otel' in payload.host).toBe(false)
    expect(payload.withheldKeys.host).toContain('otel')
    expect(JSON.stringify(payload)).not.toContain('secret')
  })
})

describe('merge', () => {
  test('an explicit false is a real value, not an absent key', () => {
    // Turning a switch off must actually turn it off. A merge that treated
    // falsy as absent would make the switch impossible to turn off.
    const merged = mergeHostConfig(DEFAULT_HOST_CONFIG, { continueSessionsAfterHostRestart: false, analyticsEnabled: false })
    expect(merged.continueSessionsAfterHostRestart).toBe(false)
    expect(merged.analyticsEnabled).toBe(false)
  })
})

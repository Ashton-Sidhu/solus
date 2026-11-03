import { afterEach, describe, expect, mock, test } from 'bun:test'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { ProviderInstance } from '@solus/contracts/provider-instances'
import { MDM_POLICY_FILES, MDM_PROFILE_PLIST, MdmPolicyError, readMdmPolicy, type MdmPolicyEnvironment } from '@solus/server/host/policy/mdm-policy'
import { resolveEffectiveServerOptions } from '@solus/server/transport/bind-policy'
import { sessionPermissionUpdates } from '@solus/server/execution/agents/claude/claude-permissions'
import { governedInstance } from '@solus/server/execution/seats/provider-runtime'

// plans/030 §5.1 and §6: the MDM policy is read from one source and stops the host
// when it cannot be enforced; a ceiling owns the provider launch; Claude's "Allow
// for Session" cannot switch a run above the ceiling; and a policy without remote
// access never binds beyond loopback.

// The agent runner's span store opens the database module; Bun has no node:sqlite.
mock.module('node:sqlite', () => ({ DatabaseSync }))

const POLICY = JSON.stringify({ schemaVersion: 1, organization: { name: 'Example Corp' }, sessions: { limits: { maxPermissionMode: 'supervised' } } })

function machine(files: { [path: string]: string }, overrides: Partial<MdmPolicyEnvironment> = {}): MdmPolicyEnvironment {
  return {
    platform: 'linux',
    exists: (path) => Object.hasOwn(files, path),
    readFile: (path) => files[path] ?? '',
    run: async () => { throw new Error('no tool in this test') },
    devOverridePath: null,
    ...overrides,
  }
}

describe('the MDM policy', () => {
  test('no source installed means no policy', async () => {
    expect(await readMdmPolicy(machine({}))).toBeNull()
  })

  test('the file is read and fingerprinted', async () => {
    const policy = await readMdmPolicy(machine({ [MDM_POLICY_FILES.linux!]: POLICY }))
    expect(policy?.document.organization.name).toBe('Example Corp')
    expect(policy?.fingerprint).toMatch(/^[0-9a-f]{12}$/)
  })

  test('a document the host cannot fully enforce stops it, and the error names the source', async () => {
    // WHY: a host that starts anyway would look managed without being managed.
    const bad = JSON.stringify({ schemaVersion: 1, organization: { name: 'Example Corp' }, limits: { telemetry: false } })
    await expect(readMdmPolicy(machine({ [MDM_POLICY_FILES.linux!]: bad }))).rejects.toThrow(MdmPolicyError)
    await expect(readMdmPolicy(machine({ [MDM_POLICY_FILES.linux!]: bad }))).rejects.toThrow('/etc/solus/policy.json')
    await expect(readMdmPolicy(machine({ [MDM_POLICY_FILES.linux!]: '{ not json' }))).rejects.toThrow('not JSON')
  })

  test('a macOS profile and a file together refuse to start: sources are never merged', async () => {
    const both = machine({ [MDM_POLICY_FILES.darwin!]: POLICY, [MDM_PROFILE_PLIST]: '' }, { platform: 'darwin', run: async () => POLICY })
    await expect(readMdmPolicy(both)).rejects.toThrow('two MDM sources')
  })

  test('the macOS profile is read through plutil, and the Windows registry value through reg', async () => {
    // A device profile adds its own Payload* keys; they are dropped, not refused.
    const profile = JSON.stringify({ ...JSON.parse(POLICY), PayloadUUID: 'X', PayloadVersion: 1 })
    const mac = await readMdmPolicy(machine({ [MDM_PROFILE_PLIST]: '' }, { platform: 'darwin', run: async (command) => (command.endsWith('plutil') ? profile : '') }))
    expect(mac?.source).toBe('configuration profile com.solus.app')
    const windows = await readMdmPolicy(machine({}, { platform: 'win32', run: async () => `\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Solus\n    Policy    REG_SZ    ${POLICY}\n` }))
    expect(windows?.document.sessions?.limits?.maxPermissionMode).toBe('supervised')
  })

  test('a dev override is read only when the build allows one', async () => {
    const override = await readMdmPolicy(machine({ '/tmp/dev-policy.json': POLICY }, { devOverridePath: '/tmp/dev-policy.json' }))
    expect(override?.source).toBe('/tmp/dev-policy.json')
  })
})

const INSTANCE: ProviderInstance = {
  id: 'claude-code', provider: 'claude-code', displayName: 'Claude', accentColor: null, enabled: true, defaultModel: null,
  binaryPath: '/Users/me/bin/claude-wrapper', homePath: '~/.claude-work', shadowHomePath: '',
  launchArgs: ['--dangerously-skip-permissions'], environment: [{ name: 'NODE_OPTIONS', value: '--require evil.js', sensitive: false }],
  autoCompactWindow: null, idleCompaction: 'default', customModels: [], hiddenModels: [], favoriteModels: [], modelOrder: [],
}

describe('the provider launch under a policy', () => {
  test('a ceiling drops the person\'s binary, arguments, environment, and homes: each could turn approvals off', () => {
    const governed = governedInstance(INSTANCE, { ownsLaunch: true, pin: null })
    expect(governed.binaryPath).toBe('')
    expect(governed.launchArgs).toEqual([])
    expect(governed.environment).toEqual([])
    expect(governed.homePath).toBe('')
    // The stored instance is unchanged: its values come back when the policy goes.
    expect(INSTANCE.launchArgs).toEqual(['--dangerously-skip-permissions'])
  })

  test('a launch pin is laid over the instance; without a ceiling the person keeps the rest', () => {
    const pin = { environment: [{ name: 'CLAUDE_CODE_USE_BEDROCK', value: '1' }] }
    const pinned = governedInstance(INSTANCE, { ownsLaunch: false, pin })
    expect(pinned.binaryPath).toBe('/Users/me/bin/claude-wrapper')
    expect(pinned.environment.map((variable) => variable.name)).toEqual(['NODE_OPTIONS', 'CLAUDE_CODE_USE_BEDROCK'])
    const owned = governedInstance(INSTANCE, { ownsLaunch: true, pin })
    expect(owned.environment.map((variable) => variable.name)).toEqual(['CLAUDE_CODE_USE_BEDROCK'])
  })

  test('no policy leaves the instance as it is', () => {
    expect(governedInstance(INSTANCE, { ownsLaunch: false, pin: null })).toBe(INSTANCE)
  })
})

describe('Claude\'s Allow for Session under a ceiling', () => {
  test('a suggestion to switch above the ceiling is dropped; rules and lower modes stay', () => {
    const suggestions = [
      { type: 'setMode' as const, mode: 'bypassPermissions' as const, destination: 'session' as const },
      { type: 'setMode' as const, mode: 'acceptEdits' as const, destination: 'session' as const },
      { type: 'addRules' as const, rules: [{ toolName: 'Bash', ruleContent: 'git status' }], behavior: 'allow' as const, destination: 'localSettings' as const },
    ]
    const kept = sessionPermissionUpdates('Bash', suggestions, 'accept-edits')
    expect(kept?.map((update) => update.type === 'setMode' ? update.mode : update.type)).toEqual(['acceptEdits', 'addRules'])
    expect(sessionPermissionUpdates('Bash', suggestions, null)).toHaveLength(3)
  })
})

describe('the bind without remote access', () => {
  const saved = process.env.SOLUS_HOST
  afterEach(() => {
    if (saved === undefined) delete process.env.SOLUS_HOST
    else process.env.SOLUS_HOST = saved
  })

  test('the host binds to loopback, and a wider SOLUS_HOST refuses to start instead of listening', () => {
    delete process.env.SOLUS_HOST
    expect(resolveEffectiveServerOptions({ remoteAccess: true, remoteAllowed: false }).host).toBe('127.0.0.1')
    process.env.SOLUS_HOST = '0.0.0.0'
    expect(() => resolveEffectiveServerOptions({ remoteAllowed: false, refusal: 'Example Corp does not allow remote access' })).toThrow('cannot listen on 0.0.0.0')
    expect(resolveEffectiveServerOptions({}).host).toBe('0.0.0.0')
  })
})

describe('the backstop where every provider process starts', () => {
  test('AgentRunner.run refuses a run above the ceiling before the provider starts, whatever path asked for it', async () => {
    // WHY: queue drains, restarts, automations, and text generation never pass turn admission; this is the one place they all meet.
    const { AgentRunner } = await import('@solus/server/execution/agents/agent-runner')
    const { HostPolicyStore, useHostPolicyStore } = await import('@solus/server/host/policy/host-policy-store')
    const document = { schemaVersion: 1 as const, organization: { name: 'Example Corp' }, sessions: { limits: { maxPermissionMode: 'supervised' as const } } }
    useHostPolicyStore(new HostPolicyStore({ mdm: { source: 'test', document, fingerprint: 'test' }, standing: () => null }))
    let started = 0
    const backend = { startRun: () => { started += 1; throw new Error('started') }, on: () => {}, off: () => {} }
    const runner = new AgentRunner(new Map([['codex', backend as never]]))
    const request = { organizationId: 'local', provider: 'codex' as const, prompt: 'hi', cwd: '/tmp', tools: [], persistence: 'ephemeral' as const, service: 'solus.text_generation' as never }
    try {
      expect(() => runner.run({ ...request, permissionMode: 'full-access' })).toThrow('limits sessions to Supervised')
      expect(started).toBe(0)
      expect(() => runner.run({ ...request, permissionMode: 'supervised' })).toThrow('started')
      expect(started).toBe(1)
    } finally {
      useHostPolicyStore(new HostPolicyStore({ mdm: null, standing: () => null }))
    }
  })
})

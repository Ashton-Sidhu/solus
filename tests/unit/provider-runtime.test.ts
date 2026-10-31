import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readlinkSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newProviderInstance } from '@solus/contracts/provider-instances'
import { HOST_LOGIN_SEAT } from '@solus/contracts/seats'
import { ActingIdentity } from '@solus/server/execution/seats/acting-identity'
import { withActingScope } from '@solus/server/vault/acting-scope'
import { instanceRuntime, prepareProviderHome, providerHistoryReference, providerHistoryInstanceId } from '@solus/server/execution/seats/provider-runtime'

function usingHome(run: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), 'solus-instance-runtime-'))
  try { run(home) } finally { rmSync(home, { recursive: true, force: true }) }
}
describe('provider instance execution settings', () => {
  test('persisted history references identify the private instance and refuse another user', () => {
    const reference = providerHistoryReference('alice', 'work')
    expect(reference).not.toContain('alice')
    expect(providerHistoryInstanceId(reference, 'alice')).toBe('work')
    expect(() => providerHistoryInstanceId(reference, 'bob')).toThrow('another Solus user')
    expect(() => providerHistoryInstanceId(providerHistoryReference('alice', '../other'), 'alice')).toThrow('invalid instance')
  })
  test('a separate home uses its own credentials and keeps only explicit instance keys', () => usingHome((home) => {
    const instance = newProviderInstance('claude-code', 'work', 'Work')
    instance.homePath = '~/.claude-work'
    instance.environment = [{ name: 'ANTHROPIC_API_KEY', value: 'instance-key', sensitive: true }]
    const identity = new ActingIdentity(HOST_LOGIN_SEAT, null)
    const runtime = withActingScope({ identity, personKey: 'alice' }, () => instanceRuntime(instance, { env: {
      HOME: home, CLAUDE_CODE_OAUTH_TOKEN: 'base-token', ANTHROPIC_API_KEY: 'base-key', OPENAI_API_KEY: 'other-base-key',
    } }))
    expect(runtime.launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(runtime.launch.env.OPENAI_API_KEY).toBeUndefined()
    expect(runtime.launch.env.ANTHROPIC_API_KEY).toBe('instance-key')
  }))
  test('resolves paths on the host, keeps arguments literal, and separates process identities by user and settings', () => usingHome((home) => {
    const instance = newProviderInstance('codex', 'work', 'Work')
    instance.binaryPath = '~/bin/custom-codex'
    instance.homePath = '~/.codex-work'
    instance.launchArgs = ['--config', 'name=literal $(no-shell)']
    instance.environment = [{ name: 'OPENAI_API_KEY', value: 'fixture-private-key', sensitive: true }]
    const identity = new ActingIdentity(HOST_LOGIN_SEAT, null)
    const runtime = withActingScope({ identity, personKey: 'alice' }, () => instanceRuntime(instance, { env: { HOME: home } }))
    expect(runtime.binaryPath).toBe(join(home, 'bin/custom-codex'))
    expect(runtime.homePath).toBe(join(home, '.codex-work'))
    expect(runtime.launchArgs).toEqual(instance.launchArgs)
    expect(runtime.launch.env.OPENAI_API_KEY).toBe('fixture-private-key')
    expect(existsSync(runtime.homePath!)).toBe(false)
    const other = withActingScope({ identity, personKey: 'bob' }, () => instanceRuntime(instance, { env: { HOME: home } }))
    expect(other.key).not.toBe(runtime.key)
    const reconnected = withActingScope({ identity, personKey: 'alice' }, () => instanceRuntime(instance, { env: { HOME: home } }, 1))
    expect(reconnected.key).not.toBe(runtime.key)
  }))
  test('members cannot point provider homes outside their own home or override the acting HOME', () => usingHome((home) => {
    const identity = new ActingIdentity({ kind: 'user', userId: { kind: 'account', accountId: 'alice' } }, null)
    const instance = newProviderInstance('codex', 'work', 'Work')
    instance.homePath = '/another-person/.codex'
    const run = () => withActingScope({ identity, personKey: 'alice' }, () => instanceRuntime(instance, { env: { HOME: home } }))
    expect(run).toThrow('inside your own home')
    instance.homePath = '~/.codex'
    instance.environment = [{ name: 'HOME', value: '/another-person', sensitive: false }]
    expect(run).toThrow('instead of overriding HOME')
  }))
  test('shadow homes share state without copying or linking authentication', () => usingHome((home) => {
    const base = join(home, 'base')
    mkdirSync(join(base, 'sessions'), { recursive: true })
    writeFileSync(join(base, 'config.toml'), 'model = "fixture"')
    writeFileSync(join(base, 'auth.json'), 'fixture-private-auth')
    const instance = newProviderInstance('codex', 'work', 'Work')
    instance.homePath = base
    instance.shadowHomePath = join(home, 'shadow')
    const identity = new ActingIdentity(HOST_LOGIN_SEAT, null)
    const runtime = withActingScope({ identity, personKey: 'alice' }, () => instanceRuntime(instance, { env: { HOME: home } }))
    prepareProviderHome(runtime)
    expect(readlinkSync(join(home, 'shadow', 'sessions'))).toBe(join(base, 'sessions'))
    expect(readlinkSync(join(home, 'shadow', 'config.toml'))).toBe(join(base, 'config.toml'))
    expect(existsSync(join(home, 'shadow', 'auth.json'))).toBe(false)
  }))
})

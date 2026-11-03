import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkPolicyFile, showPolicy, type HostPolicyInfo } from '../../apps/cli/src/lib/policy'
import { desktopRefusal } from '../../apps/cli/src/lib/desktop-commands'
import { decodeMdmPolicy, MdmPolicyError } from '../../packages/server/src/host/policy/mdm-policy'

// `solus policy check` lets an administrator prove a policy.json before it is
// installed: a document the host would refuse must be refused here too.
// `solus policy show` tells IT whether the running host enforces the installed
// policy, because a change applies only at the next host start (plans/030 §5.1).

const VALID = {
  schemaVersion: 1,
  organization: { name: 'Example Corp' },
  host: { analyticsEnabled: false, updates: { mode: 'off' } },
  sessions: {
    settings: { extraInstructions: 'Never push to main.' },
    limits: {
      maxPermissionMode: 'accept-edits',
      providers: {
        allowed: ['claude-code'],
        launch: { 'claude-code': { environment: [{ name: 'ANTHROPIC_API_KEY', value: 'secret-token' }] } },
      },
      models: { 'claude-code': ['claude-opus-5-5'] },
    },
  },
}

describe('solus policy check', () => {
  const directories: string[] = []
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

  function policyFile(content: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'solus-cli-policy-'))
    directories.push(directory)
    const file = join(directory, 'policy.json')
    writeFileSync(file, content)
    return file
  }

  function check(content: string): { code: number; lines: string[] } {
    const lines: string[] = []
    const code = checkPolicyFile(policyFile(content), (line) => lines.push(line))
    return { code, lines }
  }

  test('a valid policy exits 0 and says what it locks and limits', () => {
    const { code, lines } = check(JSON.stringify(VALID))
    expect(code).toBe(0)
    const text = lines.join('\n')
    expect(text).toContain('Organization: Example Corp')
    expect(text).toContain('analyticsEnabled: false')
    expect(text).toContain('extraInstructions: Never push to main.')
    expect(text).toContain('Highest permission mode: accept-edits')
    expect(text).toContain('Allowed providers: claude-code')
    expect(text).toContain('Allowed models for claude-code: claude-opus-5-5')
  })

  test('a launch pin prints the variable name, never its value', () => {
    // WHY: a pin can carry a provider token, and terminal output is often pasted into tickets.
    const text = check(JSON.stringify(VALID)).lines.join('\n')
    expect(text).toContain('environment ANTHROPIC_API_KEY')
    expect(text).not.toContain('secret-token')
  })

  test('a document the host would refuse exits 1 with each issue', () => {
    // WHY: the host refuses to start on this document, so the check must not pass it.
    const { code, lines } = check(JSON.stringify({ ...VALID, host: { remoteAccess: false, trustLocalNetwork: true, unknownKey: 1 } }))
    expect(code).toBe(1)
    const text = lines.join('\n')
    expect(text).toContain('trustLocalNetwork')
    expect(text).toContain('unknownKey')
  })

  test('text that is not JSON exits 1', () => {
    expect(check('{ not json').code).toBe(1)
  })

  test('a missing file exits 1', () => {
    const lines: string[] = []
    expect(checkPolicyFile(join(tmpdir(), 'solus-no-such-policy.json'), (line) => lines.push(line))).toBe(1)
    expect(lines[0]).toContain('Cannot read')
  })
})

describe('solus policy show', () => {
  const installed = decodeMdmPolicy('/Library/Application Support/Solus/policy.json', JSON.stringify(VALID))
  const cloud: HostPolicyInfo['cloud'] = [{ organizationId: 'org_acme', kind: 'host', revision: 4 }]

  async function show(readInstalled: () => Promise<typeof installed | null>, readHost: () => Promise<HostPolicyInfo | null>) {
    const lines: string[] = []
    const code = await showPolicy({ readInstalled, readHost }, (line) => lines.push(line))
    return { code, text: lines.join('\n') }
  }

  test('says nothing needs a restart when the host loaded the installed policy', async () => {
    const { code, text } = await show(async () => installed, async () => ({ mdmFingerprint: installed.fingerprint, mdmSource: installed.source, cloud }))
    expect(code).toBe(0)
    expect(text).toContain(installed.fingerprint)
    expect(text).toContain('The running host enforces this policy.')
    expect(text).not.toContain('Restart Solus')
    expect(text).toContain('org_acme: host policy, revision 4')
  })

  test('asks for a restart when the host runs another policy or none', async () => {
    // WHY: the host reads the MDM policy only when it starts; IT must know the new one is not live yet.
    const stale = await show(async () => installed, async () => ({ mdmFingerprint: 'aaaaaaaaaaaa', mdmSource: 'x', cloud: [] }))
    expect(stale.text).toContain('Restart Solus to apply the installed policy.')
    const none = await show(async () => installed, async () => ({ mdmFingerprint: null, mdmSource: null, cloud: [] }))
    expect(none.text).toContain('Restart Solus to apply the installed policy.')
  })

  test('a removed policy that the host still enforces also asks for a restart', async () => {
    const { text } = await show(async () => null, async () => ({ mdmFingerprint: installed.fingerprint, mdmSource: installed.source, cloud: [] }))
    expect(text).toContain('No MDM policy is installed.')
    expect(text).toContain('Restart Solus to apply the installed policy.')
  })

  test('an installed policy the host cannot enforce exits 1 with the reason', async () => {
    const { code, text } = await show(async () => { throw new MdmPolicyError('/etc/solus/policy.json', 'it is not JSON') }, async () => ({ mdmFingerprint: null, mdmSource: null, cloud: [] }))
    expect(code).toBe(1)
    expect(text).toContain('/etc/solus/policy.json')
  })

  test('a host that does not run exits 1', async () => {
    const { code, text } = await show(async () => null, async () => { throw new Error('The Solus server is not running.') })
    expect(code).toBe(1)
    expect(text).toContain('not running')
  })
})

test('the solus command of the desktop app runs solus policy', () => {
  // WHY: on a managed Mac the desktop app is the host, and IT checks its policy with this command.
  expect(desktopRefusal('policy')).toBeNull()
})

import { expect, test } from 'bun:test'
import { agentInstallationRows, checkStatusLine, hostUpdateLine, providerSummary, providerUpdateRows } from '@solus/workspace-ui/components/connections/lib/host-update-rows'
import type { HostUpdateStatus, ProviderInstallation, ProviderUpdateStatus } from '@solus/contracts/host-update-types'
import { codingProviderRows } from '@solus/workspace-ui/components/servers/lib/host-onboarding'
import type { HostReadiness, SetupAgent } from '@solus/contracts/types'

test('an older host without a status is unknown, not up to date', () => {
  expect(hostUpdateLine(undefined)).toBe('Update status not reported by this host')
  expect(checkStatusLine({ kind: 'idle', reason: 'Development build' })).toBe('Development build')
  expect(checkStatusLine({ kind: 'error', message: 'Offline', latestVersion: '2.0.0', checkedAt: 0 })).toContain('last known release 2.0.0')
})

test('finishing a provider update preserves visible sign-in status and optional account access', () => {
  for (const agent of ['claude', 'codex'] as const) {
    for (const signedIn of [true, false]) {
      const readiness: HostReadiness = {
        platform: 'linux', home: '/home/test', projectsRoot: '/home/test/projects',
        git: { installed: true, identity: null, credentialHelper: false },
        github: { solusToken: false, solusLogin: null, ghCli: false, ghAuthenticated: false },
        ssh: { publicKeys: [] }, installGit: null, installGh: null,
        agents: {
          claude: { installed: true, signedIn },
          codex: { installed: true, signedIn },
        },
      }
      const signIns: Array<{ agent: SetupAgent; force?: boolean }> = []
      const rows = () => codingProviderRows({
        readiness, stages: { claude: null, codex: null },
        add: (agent, opts) => signIns.push({ agent, force: opts?.force }),
      })
      let updated: SetupAgent | undefined
      const before = providerUpdateRows(rows(), [{ agent, installedVersion: '1.0.0', check: { kind: 'available', latestVersion: '2.0.0', checkedAt: 0 } }], (agent) => { updated = agent })
      const pending = before.find((row) => row.id === agent)!
      // An available update must not take the place of the account action.
      expect(pending.secondary?.label).toBe(signedIn ? 'Switch account' : undefined)
      pending.update!.run()
      expect(updated).toBe(agent)
      expect(signIns).toEqual([])

      const after = providerUpdateRows(rows(), [{ agent, installedVersion: '2.0.0', check: { kind: 'up-to-date', checkedAt: Date.now() } }], () => {})
      const row = after.find((row) => row.id === agent)!
      expect(row.detail).toContain(signedIn ? 'Installed and signed in' : 'Installed · not signed in')
      expect(row.detail).toContain('2.0.0 · Up to date')
      expect(row.state).toBe(signedIn ? 'done' : 'available')
      if (signedIn) {
        expect(row.secondary?.label).toBe('Switch account')
        row.secondary!.run()
        expect(signIns).toEqual([{ agent, force: true }])
      } else {
        expect(row.actionLabel).toBe('Sign in')
        expect(row.secondary).toBeUndefined()
      }
    }
  }
})

test('a provider update uses the selected host action and leaves busy rows disabled', () => {
  let updated = false
  const status = { agent: 'claude' as const, installedVersion: '1.0.0', check: { kind: 'available' as const, latestVersion: '2.0.0', checkedAt: 0 } }
  const rows = providerUpdateRows([{ id: 'claude', label: 'Claude Code', state: 'done', detail: 'Installed' }], [status], () => { updated = true })
  expect(rows[0]?.detail).toContain('Installed · 1.0.0')
  expect(rows[0]?.detail).toBe('Installed · 1.0.0')
  expect(rows[0]?.update?.label).toBe('Update to 2.0.0')
  rows[0]?.update?.run()
  expect(updated).toBe(true)
  const busy = providerUpdateRows([{ id: 'claude', label: 'Claude Code', state: 'busy', detail: 'Installing…' }], [status], () => {})
  expect(busy[0]?.detail).toBe('Updating…')
  expect(busy[0]?.update).toBeUndefined()
})

function installed(agent: SetupAgent, installation: Partial<ProviderInstallation>): ProviderUpdateStatus {
  return {
    agent,
    installedVersion: '1.0.0',
    check: { kind: 'up-to-date', checkedAt: 0 },
    installation: { method: 'native', managed: true, path: `/bin/${agent}`, canUpdate: true, remediation: null, source: 'vendor', automatic: false, ...installation },
  }
}

test('every installed agent has an installation row, and a switch only when there is somewhere to go', () => {
  // WHY: the section showed only agents with two installations, so an agent
  // that Solus alone installed (Antigravity, often) was missing from the host
  // page, and the one that showed was called "Codex".
  const rows = agentInstallationRows([
    installed('claude', { method: 'homebrew', managed: false }),
    installed('codex', { existingPath: '/opt/homebrew/bin/codex' }),
    installed('agy', { existingPath: null }),
    { ...installed('claude', {}), installation: { method: 'absent', managed: false, path: null, canUpdate: true, remediation: null, source: 'vendor', automatic: false } },
  ])
  expect(rows.map(({ label, switchTo }) => [label, switchTo])).toEqual([
    ['Claude Code', 'native'],
    ['Codex', 'existing'],
    ['Google Antigravity', null],
  ])
})

test('the provider summary names every agent that is up to date', () => {
  const status = { providers: [installed('claude', {}), installed('codex', {}), installed('agy', {})] } as HostUpdateStatus
  expect(providerSummary(status)).toBe('Claude Code, Codex, and Google Antigravity are up to date')
})

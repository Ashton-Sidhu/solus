import { expect, test } from 'bun:test'
import { checkStatusLine, hostUpdateLine, providerUpdateRows } from '@solus/workspace-ui/components/connections/lib/host-update-rows'
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
      before.find((row) => row.id === agent)!.secondary!.run()
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
  expect(rows[0]?.detail).toBe('Installed · 1.0.0 · 2.0.0 available')
  rows[0]?.secondary?.run()
  expect(updated).toBe(true)
  const busy = providerUpdateRows([{ id: 'claude', label: 'Claude Code', state: 'busy', detail: 'Installing…' }], [status], () => {})
  expect(busy[0]?.detail).toBe('Updating…')
  expect(busy[0]?.secondary).toBeUndefined()
})

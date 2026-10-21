import { describe, expect, test } from 'bun:test'
import type { HostUpdateStatus } from '@solus/contracts/host-update-types'
import type { Permission } from '@solus/contracts/permissions'
import type { ServerUpdateOperation } from '@solus/contracts/server-update'
import { serverInfoAllows } from '../../apps/mobile/src/features/hosts/host-connections'
import { hostUpdateControls, serverUpdateText } from '../../apps/mobile/src/features/settings/lib/update-status'

// T3 #21402 on Solus: the phone updates Solus on a host and offers only the
// host controls this person may use. The host gates each command by a
// permission (packages/contracts/src/permissions.ts); a control it would
// refuse must not be offered.

describe('host permissions on the phone', () => {
  const ready = (permissions: Permission[] | undefined, principal: 'local-owner' | 'org-member' = 'org-member') =>
    ({ state: 'ready' as const, value: { permissions: permissions!, principal } })

  test('a held prefix covers the permission, as the host decides', () => {
    expect(serverInfoAllows(ready(['host']), 'host.admin.connections')).toBe(true)
    expect(serverInfoAllows(ready(['host.admin']), 'host.admin.connections')).toBe(true)
    expect(serverInfoAllows(ready(['host.use', 'host.sessions']), 'host.admin.connections')).toBe(false)
  })

  test("the owner's controls do not flicker off before the host answers", () => {
    expect(serverInfoAllows({ state: 'loading' }, 'host.admin')).toBe(true)
  })

  test('a host that sends no permissions grants them to its local owner only', () => {
    expect(serverInfoAllows(ready(undefined, 'local-owner'), 'host.admin')).toBe(true)
    expect(serverInfoAllows(ready(undefined, 'org-member'), 'host.admin')).toBe(false)
  })
})

describe('host update controls', () => {
  const operation = (phase: ServerUpdateOperation['phase']): ServerUpdateOperation =>
    ({ operationId: '00000000-0000-4000-8000-000000000000', version: '0.37.0', phase })
  const status = (overrides: Partial<HostUpdateStatus> = {}): HostUpdateStatus => ({
    currentVersion: '0.36.1',
    install: 'managed',
    remediation: null,
    releaseUrl: null,
    check: { kind: 'available', latestVersion: '0.37.0', checkedAt: 1 },
    serverUpdate: { supported: true, reason: null, operation: null },
    providers: [],
    ...overrides,
  })

  test('an administrator updates a host that can install the release itself', () => {
    expect(hostUpdateControls(status(), true)).toEqual({ canCheck: true, action: { kind: 'update', version: '0.37.0', retry: false } })
  })

  test('a failed update is offered again as a retry', () => {
    const failed = status({ serverUpdate: { supported: true, reason: null, operation: operation('failed') } })
    expect(hostUpdateControls(failed, true).action).toEqual({ kind: 'update', version: '0.37.0', retry: true })
  })

  test('a person without host.admin is told why, not offered a command the host refuses', () => {
    expect(hostUpdateControls(status(), false)).toEqual({ canCheck: false, action: { kind: 'limited' } })
  })

  test('an update that waits for running work can be cancelled; one that downloads cannot', () => {
    const waiting = status({ serverUpdate: { supported: true, reason: null, operation: operation('waiting') } })
    expect(hostUpdateControls(waiting, true)).toEqual({ canCheck: false, action: { kind: 'cancel' } })
    const downloading = status({ serverUpdate: { supported: true, reason: null, operation: operation('downloading') } })
    expect(hostUpdateControls(downloading, true).action).toEqual({ kind: 'updating' })
  })

  test('a host that cannot install the release says what to do instead', () => {
    const unsupported = status({ serverUpdate: { supported: false, reason: 'Run the installer again.', operation: null } })
    expect(hostUpdateControls(unsupported, true).action).toEqual({ kind: 'manual', text: 'Run the installer again.' })
  })

  test('a Solus cloud host offers nothing: Solus cloud updates it', () => {
    expect(hostUpdateControls(status({ install: 'cloud' }), true)).toEqual({ canCheck: false, action: { kind: 'none' } })
  })

  test('the update line names each phase', () => {
    expect(serverUpdateText(operation('waiting'))).toBe('Waiting for running work to finish…')
    expect(serverUpdateText({ ...operation('failed'), message: 'disk full' })).toBe('Update failed: disk full')
  })
})

import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newProviderInstance } from '@solus/contracts/provider-instances'
import { HOST_LOGIN_SEAT, type Seat } from '@solus/contracts/seats'
import { ActingIdentity } from '@solus/server/execution/seats/acting-identity'
import { ProviderInstanceAuth } from '@solus/server/execution/seats/provider-instance-auth'
import { privateProviderInstances } from '@solus/server/execution/seats/provider-instances'
import type { SeatConnector } from '@solus/server/execution/seats/seat-connect'
import type { SeatStore } from '@solus/server/execution/seats/seat-manager'
import { withActingScope } from '@solus/server/vault/acting-scope'

// Claude Code on macOS keys its keychain login by CLAUDE_CONFIG_DIR, so naming
// even the default directory hides the host login. The fake CLI records the
// CLAUDE_CONFIG_DIR its status check received.
async function configDirSeenBy(seat: Seat, personKey: string): Promise<{ seen: string; seatHome: string }> {
  const root = mkdtempSync(join(tmpdir(), 'solus-instance-auth-'))
  try {
    const binary = join(root, 'claude')
    const record = join(root, 'config-dir')
    writeFileSync(binary, `#!/bin/sh\nprintf '%s' "\${CLAUDE_CONFIG_DIR:-default}" > '${record}'\necho '{"loggedIn":true}'\n`)
    chmodSync(binary, 0o755)
    const instances = privateProviderInstances()
    const instance = { ...newProviderInstance('claude-code', 'status-check', 'Status check'), binaryPath: binary }
    instances.write(personKey, { expectedRevision: instances.snapshot(personKey).revision, change: { kind: 'save', instance } })
    const seatHome = join(root, 'seat-home')
    const seats = { homeFor: () => seatHome } as unknown as SeatStore
    const auth = new ProviderInstanceAuth({ seats, connector: {} as SeatConnector, changed: () => {} })
    await withActingScope({ identity: new ActingIdentity(seat, null), personKey }, () => auth.status(seat, 'status-check'))
    return { seen: readFileSync(record, 'utf8'), seatHome }
  } finally { rmSync(root, { recursive: true, force: true }) }
}

describe('provider instance status', () => {
  test('reads the host login where the CLI looks by default, as its runs do', async () => {
    const { seen } = await configDirSeenBy(HOST_LOGIN_SEAT, 'host-person')
    expect(seen).toBe('default')
  })
  test('reads a member seat login from that seat home', async () => {
    const { seen, seatHome } = await configDirSeenBy({ kind: 'user', userId: { kind: 'account', accountId: 'member' } }, 'member-person')
    expect(seen).toBe(seatHome)
  })
})

import { describe, expect, test } from 'bun:test'
import type { HostEventMap, HostEventName } from '@solus/contracts/host-events'
import type { ForwardedHost, SshAddProgress, SshAddRequest, SshAddResult } from '@solus/contracts/remote-machines'
import { ForwardedHosts, forwardedHostRow, forwardedRemoveChoice, type ForwardedHostsConnection } from '../../apps/mobile/src/features/hosts/forwarded-hosts'
import { runSshAdd, sshAddFormIssue, sshAddOutcome, sshProgressLines, sshRunnerChoices, type SshAddForm } from '../../apps/mobile/src/features/hosts/lib/ssh-add'

// A phone cannot run SSH: it asks a connected host to (docs/plans/host-routes.md D6).
// A machine linked to the account is reachable from the phone; a forwarded one only
// from the host that holds the forward (D7), and a linked host's failed forward is
// not an error while the tunnel works (D9).

const TICKET = { ticket: 'tk-1', directoryUrl: 'https://app.solus.sh', expiresAt: 0 }

function forwarded(overrides: Partial<ForwardedHost> = {}): ForwardedHost {
  return {
    installationId: 'inst-box',
    label: 'box',
    sshTarget: 'me@box',
    route: { kind: 'forwarded', url: 'http://127.0.0.1:5123', viaHostId: 'inst-mac' },
    identityKey: 'key-box',
    state: 'open',
    startedBySolus: true,
    isLinked: false,
    ...overrides,
  }
}

/** Event fan-out for one fake host connection. */
class FakeEvents {
  private readonly listeners = new Map<HostEventName, Set<(payload: never) => void>>()
  subscribe<K extends HostEventName>(type: K, listener: (payload: HostEventMap[K]) => void): () => void {
    const set = this.listeners.get(type) ?? new Set()
    this.listeners.set(type, set)
    set.add(listener as (payload: never) => void)
    return () => { set.delete(listener as (payload: never) => void) }
  }
  emit<K extends HostEventName>(type: K, payload: HostEventMap[K]): void {
    for (const listener of this.listeners.get(type) ?? []) (listener as (payload: HostEventMap[K]) => void)(payload)
  }
  count(type: HostEventName): number {
    return this.listeners.get(type)?.size ?? 0
  }
}

const FORM: SshAddForm = { runnerHostId: 'inst-mac', sshTarget: ' me@box ', shouldLink: true, authSecret: 'pw' }

describe('the host that runs SSH for the phone', () => {
  const hosts = [
    { hostId: 'old', label: 'Old', lastConnected: 1 },
    { hostId: 'new', label: 'New', lastConnected: 3 },
    { hostId: 'off', label: 'Off', lastConnected: 9 },
  ]
  const canRun = (hostId: string) => hostId !== 'off'

  test('only a connected host that allows local reach runs it; the last connected is the default', () => {
    expect(sshRunnerChoices(hosts, canRun).map((host) => host.hostId)).toEqual(['new', 'old'])
  })

  test('the host whose details opened the flow is the default when it can run SSH', () => {
    expect(sshRunnerChoices(hosts, canRun, 'old')[0]!.hostId).toBe('old')
    expect(sshRunnerChoices(hosts, canRun, 'off')[0]!.hostId).toBe('new')
  })

  test('the form needs a runner and a target', () => {
    expect(sshAddFormIssue({ ...FORM, runnerHostId: null })).toContain('Connect a computer')
    expect(sshAddFormIssue({ ...FORM, sshTarget: '  ' })).toContain('SSH target')
    expect(sshAddFormIssue(FORM)).toBeNull()
  })
})

describe('one add over SSH', () => {
  function runner(answer: (request: SshAddRequest, events: FakeEvents) => SshAddResult) {
    const events = new FakeEvents()
    const requests: SshAddRequest[] = []
    const connection = {
      events,
      api: {
        hostsAddOverSsh: async (request: SshAddRequest) => {
          requests.push(request)
          return answer(request, events)
        },
      },
    }
    return { connection, events, requests }
  }

  test('a link sends a ticket from the account and the password; progress of other adds is not shown', async () => {
    const { connection, events, requests } = runner((request, events) => {
      events.emit('host.sshProgress', { requestId: 'other', step: 'connect', message: 'not ours' })
      events.emit('host.sshProgress', { requestId: request.requestId, step: 'install', message: 'Installing' })
      return { status: 'linked', installationId: 'inst-box', label: 'box' }
    })
    const seen: SshAddProgress[] = []
    const result = await runSshAdd(connection, FORM, { requestId: 'r1', deviceLabel: 'Phone', issueTicket: async () => TICKET, onProgress: (event) => seen.push(event) })
    expect(result.status).toBe('linked')
    expect(requests[0]).toEqual({ sshTarget: 'me@box', requestId: 'r1', deviceLabel: 'Phone', link: { ticket: 'tk-1', directoryUrl: 'https://app.solus.sh' }, authSecret: 'pw' })
    expect(seen.map((event) => event.message)).toEqual(['Installing'])
    expect(events.count('host.sshProgress')).toBe(0)
  })

  test('without a link no ticket is asked and no password is sent: a forward needs a key', async () => {
    let asked = false
    const { connection, requests } = runner(() => ({ status: 'forwarded', host: forwarded(), sessionToken: 'st' }))
    await runSshAdd(connection, { ...FORM, shouldLink: false }, { requestId: 'r2', deviceLabel: 'Phone', issueTicket: async () => { asked = true; return TICKET }, onProgress: () => {} })
    expect(asked).toBe(false)
    expect(requests[0]!.link).toBeUndefined()
    expect(requests[0]!.authSecret).toBeUndefined()
  })

  test('a link while signed out fails before the host is asked', async () => {
    const { connection, requests } = runner(() => ({ status: 'linked', installationId: 'x', label: 'x' }))
    await expect(runSshAdd(connection, FORM, { requestId: 'r3', deviceLabel: 'Phone', issueTicket: async () => null, onProgress: () => {} })).rejects.toThrow('Sign in')
    expect(requests).toHaveLength(0)
  })

  test('the subscription ends when the host refuses', async () => {
    const { connection, events } = runner(() => { throw new Error('That SSH target is this computer.') })
    await expect(runSshAdd(connection, FORM, { requestId: 'r4', deviceLabel: 'Phone', issueTicket: async () => TICKET, onProgress: () => {} })).rejects.toThrow('this computer')
    expect(events.count('host.sshProgress')).toBe(0)
  })
})

describe('what the phone shows for each answer', () => {
  test('a forwarded machine is reachable only from the host that ran SSH', () => {
    const outcome = sshAddOutcome({ status: 'forwarded', host: forwarded(), sessionToken: 'st' }, 'Mac', false)
    expect(outcome.kind).toBe('forwarded')
    expect(outcome.kind === 'forwarded' && outcome.note).toContain('reachable only from Mac')
  })

  test('a linked machine is in the account', () => {
    const outcome = sshAddOutcome({ status: 'linked', installationId: 'inst-box', label: 'box' }, 'Mac', true)
    expect(outcome).toMatchObject({ kind: 'linked', installationId: 'inst-box' })
  })

  test('a refused key asks for a password only with a link; without one it asks for a key', () => {
    const result: SshAddResult = { status: 'needs-auth', sshTarget: 'me@box', message: 'Permission denied.' }
    expect(sshAddOutcome(result, 'Mac', true)).toMatchObject({ kind: 'ask-auth', canUsePassword: true })
    const withoutLink = sshAddOutcome(result, 'Mac', false)
    expect(withoutLink).toMatchObject({ kind: 'ask-auth', canUsePassword: false })
    expect(withoutLink.kind === 'ask-auth' && withoutLink.message).toContain('needs an SSH key on Mac')
  })

  test('a missing target offers the suggestions', () => {
    const outcome = sshAddOutcome({ status: 'needs-target', candidates: [{ target: 'box', label: 'box', source: 'ssh-config' }], defaultTarget: 'box', message: 'Pick one.' }, 'Mac', true)
    expect(outcome).toMatchObject({ kind: 'ask-target', defaultTarget: 'box' })
  })

  test('progress shows one line per step, the newest current', () => {
    const lines = sshProgressLines([
      { requestId: 'r', step: 'connect', message: 'a' },
      { requestId: 'r', step: 'install', message: 'b' },
      { requestId: 'r', step: 'install', message: 'c' },
    ])
    expect(lines.map((line) => [line.step, line.message, line.isCurrent])).toEqual([['connect', 'a', false], ['install', 'c', true]])
  })
})

describe('a forwarded host row', () => {
  test('open, reconnecting, and failed with its error', () => {
    expect(forwardedHostRow(forwarded(), 'Mac')).toMatchObject({ status: 'Connected over SSH', tone: 'default', canLink: true })
    expect(forwardedHostRow(forwarded({ state: 'reconnecting' }), 'Mac').status).toBe('Reconnecting')
    const failed = forwardedHostRow(forwarded({ state: 'failed', error: 'Connection refused.' }), 'Mac')
    expect(failed).toMatchObject({ status: 'Failed', tone: 'danger' })
    expect(failed.note).toContain('Connection refused.')
    expect(failed.note).toContain('Reachable only from Mac')
  })

  test('D9: a linked host’s failed forward is muted, not an error, and offers no link', () => {
    const row = forwardedHostRow(forwarded({ state: 'failed', error: 'timeout', isLinked: true }), 'Mac')
    expect(row).toEqual({ status: 'SSH route paused', note: 'SSH route paused — using your account’s tunnel.', tone: 'muted', canLink: false })
  })

  test('remove offers to stop Solus only where Solus started it and the host is not linked', () => {
    expect(forwardedRemoveChoice(forwarded(), 'Mac').offersStop).toBe(true)
    expect(forwardedRemoveChoice(forwarded({ startedBySolus: false }), 'Mac').offersStop).toBe(false)
    const linked = forwardedRemoveChoice(forwarded({ isLinked: true }), 'Mac')
    expect(linked.offersStop).toBe(false)
    expect(linked.message).toContain('stays linked')
  })
})

describe('the forwarded hosts of one connected host', () => {
  function world(initial: ForwardedHost[]) {
    const events = new FakeEvents()
    const calls: string[] = []
    let directoryReads = 0
    const connection: ForwardedHostsConnection = {
      events,
      api: {
        hostsListForwarded: async () => initial,
        hostsRemoveForwarded: async ({ installationId, stopRemote }) => { calls.push(`remove ${installationId} ${stopRemote}`); return { removed: true } },
        hostsLinkForwarded: async ({ installationId, link }) => { calls.push(`link ${installationId} ${link.ticket}`); return { linked: true } },
      },
    }
    const store = new ForwardedHosts((hostId) => hostId === 'inst-mac' ? connection : null, async () => TICKET, () => { directoryReads += 1 })
    return { store, events, calls, directoryReads: () => directoryReads }
  }

  test('loads the list and follows the host’s changes', async () => {
    const { store, events } = world([forwarded()])
    await store.load('inst-mac')
    expect(store.stateOf('inst-mac')).toMatchObject({ kind: 'loaded', hosts: [{ state: 'open' }] })
    events.emit('host.forwardedHostsChanged', { hosts: [forwarded({ state: 'failed', error: 'x' })] })
    expect(store.stateOf('inst-mac')).toMatchObject({ kind: 'loaded', hosts: [{ state: 'failed' }] })
  })

  test('a host that cannot be reached is an error, not an empty list', async () => {
    const { store } = world([])
    await store.load('gone')
    expect(store.stateOf('gone')).toEqual({ kind: 'error', message: 'This host cannot be reached now.' })
  })

  test('a link uses the account’s ticket, marks the host linked, and reads the directory again', async () => {
    const { store, calls, directoryReads } = world([forwarded()])
    await store.load('inst-mac')
    await store.link('inst-mac', 'inst-box')
    expect(calls).toEqual(['link inst-box tk-1'])
    expect(store.stateOf('inst-mac')).toMatchObject({ hosts: [{ isLinked: true }], busyIds: [] })
    expect(directoryReads()).toBe(1)
  })

  test('remove drops the row and passes the stop choice', async () => {
    const { store, calls } = world([forwarded()])
    await store.load('inst-mac')
    await store.remove('inst-mac', 'inst-box', true)
    expect(calls).toEqual(['remove inst-box true'])
    expect(store.stateOf('inst-mac')).toMatchObject({ kind: 'loaded', hosts: [] })
  })

  test('forgetting the host ends its subscription', async () => {
    const { store, events } = world([forwarded()])
    await store.load('inst-mac')
    store.forgetHost('inst-mac')
    expect(events.count('host.forwardedHostsChanged')).toBe(0)
    expect(store.stateOf('inst-mac')).toEqual({ kind: 'idle' })
  })
})

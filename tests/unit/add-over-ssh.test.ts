import { describe, expect, test } from 'bun:test'
import type { ForwardedHost, SshAddResult } from '@solus/contracts/remote-machines'
import {
  forwardedReachNote,
  forwardedRowStatus,
  forwardsNewlyWaiting,
  sshAddOutcome,
  sshAddRequest,
  sshBridgePhase,
} from '@solus/workspace-ui/components/servers/lib/add-over-ssh'

const LINK = { ticket: 'ticket-1', directoryUrl: 'https://app.solus.sh' }

function forwardedHost(overrides: Partial<ForwardedHost> = {}): ForwardedHost {
  return {
    installationId: 'install-box',
    label: 'box',
    sshTarget: 'me@box',
    route: { kind: 'forwarded', url: 'http://127.0.0.1:41001', source: 'ssh', viaHostId: 'install-mac' },
    identityKey: 'key-box',
    state: 'open',
    startedBySolus: true,
    isLinked: false,
    ...overrides,
  }
}

const form = { sshTarget: '  me@box  ', identityFile: '', deviceLabel: 'Mac', requestId: 'req-1' }

describe('the SSH add request', () => {
  test('a password goes to the host with or without a link, because a forward can sign in with it', () => {
    const withoutLink = sshAddRequest({ ...form, linkToAccount: false, password: 'hunter2' }, null)
    expect(withoutLink).toEqual({ sshTarget: 'me@box', deviceLabel: 'Mac', requestId: 'req-1', authSecret: 'hunter2' })

    const withLink = sshAddRequest({ ...form, linkToAccount: true, password: 'hunter2' }, LINK)
    expect(withLink).toEqual({ sshTarget: 'me@box', deviceLabel: 'Mac', requestId: 'req-1', link: LINK, authSecret: 'hunter2' })
  })

  test('an identity file goes with or without a link, because a forward signs in with that key too', () => {
    expect(sshAddRequest({ ...form, identityFile: ' ~/.ssh/aws.pem ', linkToAccount: false, password: '' }, null).identityFile).toBe('~/.ssh/aws.pem')
    expect(sshAddRequest({ ...form, identityFile: '~/.ssh/aws.pem', linkToAccount: true, password: '' }, LINK).identityFile).toBe('~/.ssh/aws.pem')
    expect(sshAddRequest({ ...form, identityFile: '  ', linkToAccount: false, password: '' }, null)).not.toHaveProperty('identityFile')
  })

  test('a link choice without a ticket sends no link, so the host never links with nothing', () => {
    expect(sshAddRequest({ ...form, linkToAccount: true, password: 'x' }, null).link).toBeUndefined()
  })
})

describe('the outcome of an SSH add', () => {
  const desktop = { sshHostIsThisMachine: true, sshHostName: 'Studio Mac' }
  const web = { sshHostIsThisMachine: false, sshHostName: 'Linux server' }
  const forwarded: SshAddResult = { status: 'forwarded', host: forwardedHost(), sessionToken: 'token' }

  test('a forward held by this machine is saved, because only this machine can dial it', () => {
    expect(sshAddOutcome(forwarded, desktop).kind).toBe('save-forwarded')
  })

  test('a forward held by another host is not saved, and names the one machine that reaches it', () => {
    const outcome = sshAddOutcome(forwarded, web)
    expect(outcome.kind).toBe('forwarded-elsewhere')
    expect(outcome.message).toContain('reachable only from Linux server')
  })

  test('a refused key asks for a password, with or without a link', () => {
    const refused: SshAddResult = { status: 'needs-auth', sshTarget: 'me@box', message: 'Permission denied.' }
    const outcome = sshAddOutcome(refused, desktop)
    expect(outcome.kind).toBe('ask-password')
    expect(outcome.message).toContain('Enter the password for me@box')
  })

  test('a linked host is done through the account directory', () => {
    expect(sshAddOutcome({ status: 'linked', installationId: 'i', label: 'box' }, web).kind).toBe('linked')
  })
})

describe('a forwarded row', () => {
  test('a failed forward of a linked host is muted, not an error: the tunnel still reaches it (D9)', () => {
    expect(forwardedRowStatus(forwardedHost({ state: 'failed', error: 'Connection refused', isLinked: true }))).toEqual({
      text: 'SSH route paused — using your account\'s tunnel',
      tone: 'muted',
    })
  })

  test('a failed forward of a host with no link is an error that shows the SSH error', () => {
    expect(forwardedRowStatus(forwardedHost({ state: 'failed', error: 'Connection refused' }))).toEqual({ text: 'Connection refused', tone: 'error' })
  })

  test('open and reconnecting say so', () => {
    expect(forwardedRowStatus(forwardedHost()).tone).toBe('ok')
    expect(forwardedRowStatus(forwardedHost({ state: 'reconnecting' })).tone).toBe('pending')
  })

  test('only a client away from the holding machine is told where the host is reachable from (D7)', () => {
    expect(forwardedReachNote(forwardedHost(), true, 'Studio Mac')).toBeNull()
    expect(forwardedReachNote(forwardedHost(), false, 'Studio Mac')).toBe('Reachable only from Studio Mac')
    expect(forwardedReachNote(forwardedHost({ isLinked: true }), false, 'Studio Mac')).toBeNull()
  })
})

describe('the pairing bridge on the SSH tab', () => {
  test('the bridge follows the add, so the SSH tab moves like pairing does', () => {
    expect(sshBridgePhase({ phase: 'form', sshTarget: '  ', error: '' })).toBe('empty')
    expect(sshBridgePhase({ phase: 'form', sshTarget: 'me@box', error: '' })).toBe('found')
    expect(sshBridgePhase({ phase: 'running', sshTarget: 'me@box', error: '' })).toBe('pairing')
    expect(sshBridgePhase({ phase: 'form', sshTarget: 'me@box', error: 'SSH refused the key.' })).toBe('error')
    expect(sshBridgePhase({ phase: 'done', sshTarget: 'me@box', error: '' })).toBe('paired')
  })
})

describe('a forward that waits for its password', () => {
  test('asks without an error until SSH refuses a password', () => {
    expect(forwardedRowStatus({ state: 'needs-auth', isLinked: false })).toEqual({ text: 'Password needed to reconnect', tone: 'pending' })
    expect(forwardedRowStatus({ state: 'needs-auth', isLinked: false, error: 'box refused that password or passphrase.' })).toEqual({ text: 'box refused that password or passphrase.', tone: 'error' })
  })

  test('a linked host still has its tunnel, so it is not an alarm (D9)', () => {
    expect(forwardedRowStatus({ state: 'needs-auth', isLinked: true }).tone).toBe('muted')
  })

  test('interrupts the person once, and never for a linked host', () => {
    const waiting = forwardedHost({ installationId: 'a', state: 'needs-auth' })
    const linked = forwardedHost({ installationId: 'b', state: 'needs-auth', isLinked: true })
    expect(forwardsNewlyWaiting([waiting, linked], new Set()).map((host) => host.installationId)).toEqual(['a'])
    expect(forwardsNewlyWaiting([waiting], new Set(['a']))).toEqual([])
  })
})

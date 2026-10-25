import { describe, expect, test } from 'bun:test'
import type { ForwardedHost, SshAddResult } from '@solus/contracts/remote-machines'
import {
  forwardedReachNote,
  forwardedRowStatus,
  sshAddOutcome,
  sshAddRequest,
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

const form = { sshTarget: '  me@box  ', deviceLabel: 'Mac', requestId: 'req-1' }

describe('the SSH add request', () => {
  test('a password goes to the host only with a link: a forward needs an SSH key (D6, D7)', () => {
    const withoutLink = sshAddRequest({ ...form, linkToAccount: false, password: 'hunter2' }, null)
    expect(withoutLink.authSecret).toBeUndefined()
    expect(withoutLink.link).toBeUndefined()

    const withLink = sshAddRequest({ ...form, linkToAccount: true, password: 'hunter2' }, LINK)
    expect(withLink).toEqual({ sshTarget: 'me@box', deviceLabel: 'Mac', requestId: 'req-1', link: LINK, authSecret: 'hunter2' })
  })

  test('a link choice without a ticket sends no link, so the host never links with nothing', () => {
    expect(sshAddRequest({ ...form, linkToAccount: true, password: 'x' }, null).link).toBeUndefined()
  })
})

describe('the outcome of an SSH add', () => {
  const desktop = { linkToAccount: false, sshHostIsThisMachine: true, sshHostName: 'Studio Mac' }
  const web = { linkToAccount: false, sshHostIsThisMachine: false, sshHostName: 'Linux server' }
  const forwarded: SshAddResult = { status: 'forwarded', host: forwardedHost(), sessionToken: 'token' }

  test('a forward held by this machine is saved, because only this machine can dial it', () => {
    expect(sshAddOutcome(forwarded, desktop).kind).toBe('save-forwarded')
  })

  test('a forward held by another host is not saved, and names the one machine that reaches it', () => {
    const outcome = sshAddOutcome(forwarded, web)
    expect(outcome.kind).toBe('forwarded-elsewhere')
    expect(outcome.message).toContain('reachable only from Linux server')
  })

  test('a refused key asks for a password only when the host links', () => {
    const refused: SshAddResult = { status: 'needs-auth', sshTarget: 'me@box', message: 'Permission denied.' }
    expect(sshAddOutcome(refused, { ...desktop, linkToAccount: true }).kind).toBe('ask-password')
    const withoutLink = sshAddOutcome(refused, desktop)
    expect(withoutLink.kind).toBe('needs-key')
    expect(withoutLink.message).toContain('SSH key')
  })

  test('a linked host is done through the account directory', () => {
    expect(sshAddOutcome({ status: 'linked', installationId: 'i', label: 'box' }, { ...web, linkToAccount: true }).kind).toBe('linked')
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

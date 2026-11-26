import { describe, expect, test } from 'bun:test'
import type { AppSignInRequest } from '@solus/contracts/host-api'
import { appSignInLink } from '@solus/contracts/outside-apps'
import {
  appSignInDoneMessage,
  appSignInFacts,
  appSignInSummary,
  appSignInLinkOf,
  AppSignIns,
  appSignInTimeLeft,
  type AppSignInHost,
} from '../../apps/mobile/solus-core/features/settings/app-sign-in'
import type { HostConnection } from '../../apps/mobile/solus-core/features/hosts/host-connections'
import { FakeApi, flushPromises } from './helpers/native-mobile-fakes'

// A person approves an outside app's sign-in on the phone: from the QR code of
// the sign-in page (a solus://approve-app link), or by typing its check code.
// The rules a person would notice going wrong: the link opens on the host it
// names, even when the phone keeps that host under another id; a link that
// arrives before the host list is read waits for it; a host the phone does not
// know says so; a late reply never shows an earlier sign-in; and a decision the
// host refused leaves the sign-in open with the reason.

const REQUEST: AppSignInRequest = {
  requestId: 'req-1',
  appName: 'Claude',
  appId: 'claude',
  redirectPlace: 'claude.ai',
  onThisComputer: false,
  access: 'write',
  expiresAt: 1_000_000,
}

function phone(options: { hosts?: AppSignInHost[]; settled?: boolean; api?: FakeApi } = {}) {
  let hosts = options.hosts ?? [{ hostId: 'cloud-host-1', installationId: 'inst-a' }]
  let settled = options.settled ?? true
  const listeners = new Set<() => void>()
  const api = options.api ?? new FakeApi().on('connectionsReadAppSignIn', () => REQUEST).on('connectionsDecideAppSignIn', () => ({ ok: true }))
  const connection = { api: api.surface() } as unknown as HostConnection
  const asked: string[] = []
  const signIns = new AppSignIns({
    hosts: () => hosts,
    hostsSettled: () => settled,
    onHostsChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    connectionFor: (hostId) => {
      asked.push(hostId)
      return hosts.some((host) => host.hostId === hostId) ? connection : null
    },
  })
  const hostsAnswer = (next: AppSignInHost[]) => {
    hosts = next
    settled = true
    for (const listener of [...listeners]) listener()
  }
  return { signIns, api, asked, hostsAnswer, listenerCount: () => listeners.size }
}

describe('approving an outside app sign-in on the phone', () => {
  test('the link opens the sign-in on the host with its installation id, kept under another id', async () => {
    const { signIns, api, asked } = phone()
    expect(signIns.openLink(appSignInLink('inst-a', 'req-1'))).toBe(true)
    await flushPromises()
    expect(asked).toEqual(['cloud-host-1'])
    expect(api.callsOf('connectionsReadAppSignIn')).toEqual([[{ requestId: 'req-1' }]])
    expect(signIns.state).toEqual({ kind: 'open', hostId: 'cloud-host-1', request: REQUEST, deciding: null, error: null })
  })

  test('a link that arrives before the host list is read waits for the list', async () => {
    const { signIns, api, hostsAnswer, listenerCount } = phone({ hosts: [], settled: false })
    signIns.openLink(appSignInLink('inst-a', 'req-1'))
    expect(signIns.state.kind).toBe('finding-host')
    hostsAnswer([{ hostId: 'inst-a', installationId: 'inst-a' }])
    await flushPromises()
    expect(signIns.state.kind).toBe('open')
    expect(api.callsOf('connectionsReadAppSignIn')).toHaveLength(1)
    expect(listenerCount()).toBe(0)
  })

  test('a host this phone does not know says so once the list answered', () => {
    const { signIns, api, hostsAnswer } = phone({ hosts: [], settled: false })
    signIns.openLink(appSignInLink('inst-other', 'req-1'))
    hostsAnswer([{ hostId: 'inst-a', installationId: 'inst-a' }])
    expect(signIns.state).toEqual({ kind: 'no-host' })
    expect(api.callsOf('connectionsReadAppSignIn')).toHaveLength(0)
  })

  test('a late reply for a sign-in that was replaced does not show', async () => {
    let answerFirst: (request: AppSignInRequest) => void = () => {}
    const api = new FakeApi().on('connectionsReadAppSignIn', (lookup: { requestId: string }) =>
      lookup.requestId === 'req-old' ? new Promise<AppSignInRequest>((resolve) => { answerFirst = resolve }) : REQUEST)
    const { signIns } = phone({ api })
    signIns.openLink(appSignInLink('inst-a', 'req-old'))
    signIns.openLink(appSignInLink('inst-a', 'req-1'))
    await flushPromises()
    answerFirst({ ...REQUEST, requestId: 'req-old', appName: 'Other app' })
    await flushPromises()
    expect(signIns.state.kind === 'open' && signIns.state.request.requestId).toBe('req-1')
  })

  test('a typed check code is read in the host format; a code in another format is not sent', async () => {
    const { signIns, api } = phone()
    signIns.enterCode('cloud-host-1')
    signIns.submitCode('abcd')
    expect(signIns.state).toEqual({ kind: 'entering-code', hostId: 'cloud-host-1', error: expect.stringContaining('ABCD-2345') })
    expect(api.callsOf('connectionsReadAppSignIn')).toHaveLength(0)
    signIns.submitCode(' abcd 2345 ')
    await flushPromises()
    expect(api.callsOf('connectionsReadAppSignIn')).toEqual([[{ checkCode: 'ABCD-2345' }]])
    expect(signIns.state.kind).toBe('open')
  })

  test('approving sends the decision and tells the person to go back to the app', async () => {
    const { signIns, api } = phone()
    signIns.openLink(appSignInLink('inst-a', 'req-1'))
    await flushPromises()
    await signIns.decide('approve')
    expect(api.callsOf('connectionsDecideAppSignIn')).toEqual([[{ requestId: 'req-1', decision: 'approve' }]])
    const state = signIns.state
    if (state.kind !== 'decided') throw new Error(`expected decided, got ${state.kind}`)
    expect(appSignInDoneMessage(state)).toBe('Approved. Go back to Claude.')
  })

  test('a decision the host refused leaves the sign-in open with the reason', async () => {
    const api = new FakeApi()
      .on('connectionsReadAppSignIn', () => REQUEST)
      .on('connectionsDecideAppSignIn', () => { throw new Error('The sign-in expired.') })
    const { signIns } = phone({ api })
    signIns.openLink(appSignInLink('inst-a', 'req-1'))
    await flushPromises()
    await signIns.decide('approve')
    expect(signIns.state).toEqual({ kind: 'open', hostId: 'cloud-host-1', request: REQUEST, deciding: null, error: 'The sign-in expired.' })
  })

  test('a sign-in the host cannot give can be read again', async () => {
    let reads = 0
    const api = new FakeApi().on('connectionsReadAppSignIn', () => {
      reads += 1
      if (reads === 1) throw new Error('No sign-in waits with this id.')
      return REQUEST
    })
    const { signIns } = phone({ api })
    signIns.openLink(appSignInLink('inst-a', 'req-1'))
    await flushPromises()
    expect(signIns.state).toEqual({ kind: 'read-failed', hostId: 'cloud-host-1', message: 'No sign-in waits with this id.' })
    signIns.retry()
    await flushPromises()
    expect(signIns.state.kind).toBe('open')
  })
})

describe('the approve-app link and the sheet text', () => {
  test('the link opens in every build; other links are not sign-ins', () => {
    expect(appSignInLinkOf('solus://approve-app?host=inst-a&request=req-1')).toEqual({ hostId: 'inst-a', requestId: 'req-1' })
    expect(appSignInLinkOf('solus-dev://approve-app?host=inst-a&request=req-1')).toEqual({ hostId: 'inst-a', requestId: 'req-1' })
    expect(appSignInLinkOf('solus-preview://approve-app?host=inst-a&request=req-1')).toEqual({ hostId: 'inst-a', requestId: 'req-1' })
    expect(appSignInLinkOf('solus://settings/environments')).toBeNull()
    expect(appSignInLinkOf('https://approve-app?host=inst-a&request=req-1')).toBeNull()
    expect(new AppSignIns({ hosts: () => [], hostsSettled: () => true, onHostsChange: () => () => {}, connectionFor: () => null }).openLink('solus://settings')).toBe(false)
  })

  test('the sheet asks about the app by name, says it acts as the person on this host, and warns before approving', () => {
    expect(appSignInSummary(REQUEST, 'Studio Mac')).toEqual({
      title: 'Approve Claude?',
      line: 'Claude will use Studio Mac as you. Only approve a sign-in you just started.',
    })
  })

  test('the facts name where access goes, what the app can do, and the time left, never more than is left', () => {
    expect(appSignInFacts(REQUEST, REQUEST.expiresAt - 479_000)).toEqual([
      { label: 'Access goes to', value: 'claude.ai' },
      { label: 'It can', value: 'Read and write' },
      { label: 'Time left', value: '7 min' },
    ])
    expect(appSignInTimeLeft(REQUEST.expiresAt, REQUEST.expiresAt - 30_000)).toBe('Less than a minute')
    expect(appSignInTimeLeft(REQUEST.expiresAt, REQUEST.expiresAt)).toBeNull()
    expect(appSignInFacts(REQUEST, REQUEST.expiresAt)[2]).toEqual({ label: 'Time left', value: 'Expired' })
  })
})

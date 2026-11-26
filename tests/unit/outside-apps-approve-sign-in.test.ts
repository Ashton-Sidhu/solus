import { afterAll, describe, expect, test } from 'bun:test'
import type { AppSignInRequest } from '@solus/contracts/host-api'
import { appSignInLink } from '@solus/contracts/outside-apps'
import {
  appSignInFromSearch,
  appSignInInput,
  appSignInPlaceText,
  appSignInTimeLeft,
  searchWithoutAppSignIn,
  serverIdForAppSignIn,
  UNKNOWN_HOST_TEXT,
} from '@solus/workspace-ui/components/connections/lib/app-sign-in'
import type { AppSignInApi } from '@solus/workspace-ui/components/connections/outside-apps/app-sign-in-approval.svelte'
import { SvelteRunes } from './helpers/svelte-runes'

// The view's state runs on Svelte's real client runtime, as in the app.
const runes = new SvelteRunes()
afterAll(() => runes.dispose())
const { AppSignInApproval }: typeof import('@solus/workspace-ui/components/connections/outside-apps/app-sign-in-approval.svelte') = await import(
  runes.source('app-sign-in-approval', 'packages/workspace-ui/src/components/connections/outside-apps/app-sign-in-approval.svelte.ts', {
    '../lib/app-sign-in': SvelteRunes.file('packages/workspace-ui/src/components/connections/lib/app-sign-in.ts'),
  })
)

// "Approve a sign-in" in "Use Solus in other apps" (plans/035 §0.5). What a
// person would notice going wrong: a typed code that never reaches the host, a
// link that opens the sign-in on the wrong host, a decision sent for a sign-in
// the person did not see, and a refusal with no words they can act on.

const REQUEST: AppSignInRequest = {
  requestId: 'req-1',
  appName: 'ChatGPT',
  appId: 'chatgpt',
  redirectPlace: 'chatgpt.com',
  onThisComputer: false,
  access: 'write',
  expiresAt: 1_000_000,
}

interface FakeHost extends AppSignInApi {
  reads: unknown[]
  decisions: unknown[]
}

function fakeHost({ readError, decideError }: { readError?: Error; decideError?: Error } = {}): FakeHost {
  const host: FakeHost = {
    reads: [],
    decisions: [],
    connectionsReadAppSignIn: async (args) => {
      host.reads.push(args)
      if (readError) throw readError
      return REQUEST
    },
    connectionsDecideAppSignIn: async (args) => {
      host.decisions.push(args)
      if (decideError) throw decideError
      return { ok: true }
    },
  }
  return host
}

const SERVERS = [
  { id: 'local', installationId: 'install-a' },
  { id: 'srv-b', installationId: 'install-b' },
]

function approvalOn(api: AppSignInApi, moves: { serverId: string; requestId: string }[] = []) {
  return new AppSignInApproval({
    serverId: 'local',
    api,
    serverIdFor: (hostId) => serverIdForAppSignIn(hostId, SERVERS),
    onOtherHost: (serverId, requestId) => moves.push({ serverId, requestId }),
  })
}

describe('what the code field takes', () => {
  test('a check code as a person types it, in the host\'s form', () => {
    expect(appSignInInput(' k7q4 92xd ')).toEqual({ kind: 'code', checkCode: 'K7Q4-92XD' })
  })

  test('the sign-in page\'s link', () => {
    expect(appSignInInput(appSignInLink('install-b', 'req-9'))).toEqual({ kind: 'link', target: { hostId: 'install-b', requestId: 'req-9' } })
  })

  test('nothing else', () => {
    expect(appSignInInput('hello')).toEqual({ kind: 'invalid' })
    expect(appSignInInput('https://example.com/approve-app?host=a&request=b')).toEqual({ kind: 'invalid' })
  })
})

describe('approving a sign-in by its code', () => {
  test('reads the sign-in on the dialog\'s host, then approves the one shown', async () => {
    const host = fakeHost()
    const approval = approvalOn(host)
    approval.code = 'k7q492xd'
    await approval.submitCode()
    expect(host.reads).toEqual([{ checkCode: 'K7Q4-92XD' }])
    expect(approval.phase).toEqual({ kind: 'shown', request: REQUEST })

    await approval.decide('approve')
    expect(host.decisions).toEqual([{ requestId: 'req-1', decision: 'approve' }])
    expect(approval.phase).toMatchObject({ kind: 'done', decision: 'approve' })
  })

  test('a code in the wrong form never reaches the host', async () => {
    const host = fakeHost()
    const approval = approvalOn(host)
    approval.code = 'K7Q4'
    await approval.submitCode()
    expect(host.reads).toEqual([])
    expect(approval.error).toContain('XXXX-XXXX')
  })

  test('no decision goes out before the person saw a sign-in', async () => {
    const host = fakeHost()
    await approvalOn(host).decide('approve')
    expect(host.decisions).toEqual([])
  })

  test('a refused read says why in plain words, and keeps the code field', async () => {
    const approval = approvalOn(fakeHost({ readError: new Error('App sign-in not found') }))
    approval.code = 'K7Q4-92XD'
    await approval.submitCode()
    expect(approval.phase).toEqual({ kind: 'enter' })
    expect(approval.error).toBe('No sign-in waits for this code. Check the code on the app\'s sign-in page.')
  })

  test('a refused decision keeps the sign-in shown, with the reason', async () => {
    const approval = approvalOn(fakeHost({ decideError: new Error('The sign-in expired') }))
    approval.code = 'K7Q4-92XD'
    await approval.submitCode()
    await approval.decide('approve')
    expect(approval.phase).toEqual({ kind: 'shown', request: REQUEST })
    expect(approval.error).toBe('This sign-in expired. Start the sign-in in the app again.')
  })

  test('a host that does not have the method asks for a pairing code', async () => {
    const approval = approvalOn(fakeHost({ readError: new Error('Unknown method "connectionsReadAppSignIn"') }))
    approval.code = 'K7Q4-92XD'
    await approval.submitCode()
    expect(approval.error).toContain('pairing code')
  })
})

describe('a sign-in link', () => {
  test('for this host, reads the sign-in it names at once', async () => {
    const host = fakeHost()
    const approval = approvalOn(host)
    await approval.openLink({ hostId: 'install-a', requestId: 'req-1' })
    expect(host.reads).toEqual([{ requestId: 'req-1' }])
    expect(approval.phase.kind).toBe('shown')
  })

  test('for another known host, moves to that host by its installation id', async () => {
    const host = fakeHost()
    const moves: { serverId: string; requestId: string }[] = []
    const approval = approvalOn(host, moves)
    approval.code = appSignInLink('install-b', 'req-9')
    await approval.submitCode()
    expect(moves).toEqual([{ serverId: 'srv-b', requestId: 'req-9' }])
    expect(host.reads).toEqual([])
  })

  test('for a host this client does not know, says so and reads nothing', async () => {
    const host = fakeHost()
    const approval = approvalOn(host)
    await approval.openLink({ hostId: 'install-z', requestId: 'req-1' })
    expect(host.reads).toEqual([])
    expect(approval.error).toBe(UNKNOWN_HOST_TEXT)
  })

  test('on the web, comes as a query that is taken off the address once read', () => {
    expect(appSignInFromSearch('?approveApp=req-1&host=install-a&tab=x')).toEqual({ hostId: 'install-a', requestId: 'req-1' })
    expect(appSignInFromSearch('?host=install-a')).toBeNull()
    expect(searchWithoutAppSignIn('?approveApp=req-1&host=install-a&tab=x')).toBe('?tab=x')
    expect(searchWithoutAppSignIn('?approveApp=req-1&host=install-a')).toBe('')
  })
})

describe('what the person reads before deciding', () => {
  test('where the access goes, and which computer when the sign-in returns to it', () => {
    expect(appSignInPlaceText(REQUEST)).toBe('Access goes to chatgpt.com.')
    expect(appSignInPlaceText({ redirectPlace: 'localhost', onThisComputer: true })).toBe('Access goes to localhost on the computer that opened the sign-in page.')
  })

  test('the time left, and none once the sign-in expired', () => {
    expect(appSignInTimeLeft(1_000_000, 1_000_000 - 299_500)).toBe('Expires in 5:00')
    expect(appSignInTimeLeft(1_000_000, 1_000_000)).toBeNull()
  })
})

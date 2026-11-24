import { afterAll, describe, expect, mock, test } from 'bun:test'
import type { PairApprovalDecision, PairApprovalRequest } from '@solus/contracts/add-machine'

mock.module('svelte-sonner', () => ({ toast: Object.assign(() => '', { success: () => '', error: () => '', info: () => '', dismiss: () => {} }) }))

// Store tests need only the values behind Svelte's state.
const originalState = Object.getOwnPropertyDescriptor(globalThis, '$state')
Object.defineProperty(globalThis, '$state', { configurable: true, value: <T>(value: T): T => value })
afterAll(() => {
  if (originalState) Object.defineProperty(globalThis, '$state', originalState)
  else Reflect.deleteProperty(globalThis, '$state')
})
const { PairApprovalsStore, approvalNoticeText } = await import('@solus/workspace-ui/contexts/connections/pair-approvals.store.svelte')

const request = (requestId: string, checkCode = 'K7QM-2XFD'): PairApprovalRequest => ({
  requestId, checkCode, deviceLabel: 'Windows PC', fromAddress: '10.10.1.10', requestedAt: 1, expiresAt: Date.now() + 60_000,
})

function harness(lists: Record<string, PairApprovalRequest[]>, reach: Record<string, boolean> = {}) {
  let push: (serverId: string, approvals: PairApprovalRequest[]) => void = () => {}
  const calls = { shown: [] as string[], dismissed: [] as string[], failed: [] as string[], decided: [] as Array<[string, string, PairApprovalDecision]>, listed: [] as string[] }
  let decideAnswer = true
  const store = new PairApprovalsStore(
    {
      list: async (serverId) => { calls.listed.push(serverId); return lists[serverId] ?? [] },
      decide: async (serverId, requestId, decision) => { calls.decided.push([serverId, requestId, decision]); return decideAnswer },
      follow: (onChange) => { push = onChange; return () => {} },
      onHostReady: () => () => {},
      hostIds: () => Object.keys(lists),
      mayReach: async (serverId) => reach[serverId] ?? true,
      hostLabel: (serverId) => serverId === 'mac' ? 'MacBook' : serverId,
    },
    {
      show: (serverId, approval) => { calls.shown.push(`${serverId}:${approval.requestId}`) },
      dismiss: (serverId, requestId) => { calls.dismissed.push(`${serverId}:${requestId}`) },
      failed: (message) => { calls.failed.push(message) },
    },
  )
  return { store, calls, push: (serverId: string, approvals: PairApprovalRequest[]) => push(serverId, approvals), setDecideAnswer: (value: boolean) => { decideAnswer = value } }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('approval requests', () => {
  test('a new request tells the owner once; the same list again tells nothing', async () => {
    // WHY: the host sends the whole list on each change, so a toast per list would repeat each open request.
    const { store, calls, push } = harness({ mac: [] })
    store.start()
    await settle()
    push('mac', [request('a')])
    push('mac', [request('a')])
    push('mac', [request('a'), request('b')])
    expect(calls.shown).toEqual(['mac:a', 'mac:b'])
    expect(store.forHost('mac')?.approvals.map((approval) => approval.requestId)).toEqual(['a', 'b'])
  })

  test('a request that leaves the list takes its toast with it', async () => {
    const { store, calls, push } = harness({ mac: [request('a')] })
    store.start()
    await settle()
    push('mac', [])
    expect(calls.dismissed).toEqual(['mac:a'])
  })

  test('a decision goes to the host that holds the request', async () => {
    const { store, calls } = harness({ mac: [request('a')], studio: [request('s')] })
    store.start()
    await settle()
    await store.decide('studio', 's', 'deny')
    expect(calls.decided).toEqual([['studio', 's', 'deny']])
    expect(store.forHost('studio')?.approvals).toEqual([])
    expect(store.forHost('mac')?.approvals.length).toBe(1)
  })

  test('a request decided elsewhere says so', async () => {
    const { store, calls, setDecideAnswer } = harness({ mac: [request('a')] })
    store.start()
    await settle()
    setDecideAnswer(false)
    await store.decide('mac', 'a', 'approve')
    expect(calls.failed).toEqual(['This request is no longer open.'])
  })

  test('a host this client does not own is not asked', async () => {
    // WHY: rule 6 — only a principal with host.local.reach lists approval requests.
    const { store, calls } = harness({ mac: [request('a')], shared: [request('x')] }, { shared: false })
    store.start()
    await settle()
    expect(calls.listed).toEqual(['mac'])
    expect(store.forHost('shared')).toBeUndefined()
  })

  test('the notice names the device, its address, the host, and the check code', () => {
    expect(approvalNoticeText(request('a'), 'MacBook')).toEqual({
      message: 'Windows PC at 10.10.1.10 asks to pair with MacBook.',
      description: 'Approve only if it shows K7QM-2XFD.',
    })
  })
})

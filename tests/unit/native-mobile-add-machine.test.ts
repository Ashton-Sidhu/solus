import { describe, expect, test } from 'bun:test'
import { rankAddMachineCandidates, type AddMachineCandidate } from '@solus/client-core/add-machine-candidates'
import { CHECK_CODE_ALPHABET, normalizeCheckCode, readAddMachineOutcome, addMachineOutcomeAnswers, type PairApprovalRequest } from '@solus/contracts/add-machine'
import type { HostApi } from '@solus/client-core/host-api'
import { DEFAULT_SERVER_PORT } from '@solus/contracts/types'
import {
  attemptAddMachine,
  makeCheckCode,
  reachableMachines,
  stepFor,
  typedCodeError,
  typedCodeValue,
  wayLabel,
  type AddMachineDeps,
  type AddMachineStep,
} from '../../apps/mobile/solus-core/features/conversation/lib/add-machine-card'
import { hasOwnCard } from '../../apps/mobile/solus-core/features/conversation/lib/pending-requests'
import { TranscriptModel } from '../../apps/mobile/solus-core/features/conversation/lib/transcript-model'
import { PairApprovals } from '../../apps/mobile/solus-core/features/settings/pair-approvals'
import { timeLeft } from '../../apps/mobile/solus-core/lib/time'
import { createHostWorld, FakeApi, flushPromises, healthFetch } from './helpers/native-mobile-fakes'
import { identityKeyFor } from './helpers/signing-host'

// The phone's Add machine card (docs/plans/add-machine-card.md). What a person
// would notice going wrong: a row that names the wrong way, a code or password
// sent before its shape is checked or kept after it is sent, a refusal that
// closes the card, and an approval request that the owner cannot see or answer.

const NO_REFUSALS: ReadonlySet<string> = new Set()

function candidate(overrides: Partial<AddMachineCandidate>): AddMachineCandidate {
  return { key: 'k', label: 'Studio', detail: '', way: 'approve', minted: false, isMatch: false, ...overrides }
}

describe('the Add machine card in the conversation', () => {
  test('a host-link question keeps what the agent asks, and gets its own card', () => {
    const model = new TranscriptModel('s')
    model.apply({ type: 'question_request', questionId: 'q1', questions: [], kind: 'host-link', hostLink: { hint: 'my windows machine', url: 'http://10.10.1.10:4810', reason: 'To run the tests there.' } })
    const question = model.questions[0]
    expect(question?.kind).toBe('host-link')
    expect(question?.hostLink).toEqual({ hint: 'my windows machine', url: 'http://10.10.1.10:4810', reason: 'To run the tests there.' })
    // Not T3's question card, and the composer cannot answer it.
    expect(hasOwnCard(question)).toBe(true)
    expect(hasOwnCard({ kind: 'secret' })).toBe(true)
    expect(hasOwnCard({ kind: 'standard' })).toBe(false)
    expect(hasOwnCard(undefined)).toBe(false)
  })

  test('each row says how the machine is added', () => {
    expect(wayLabel(candidate({ way: 'code', minted: true }))).toBe('From this device')
    expect(wayLabel(candidate({ way: 'ssh', sshTarget: 'solus-windows' }))).toBe('Over SSH · solus-windows')
    expect(wayLabel(candidate({ way: 'approve' }))).toBe('Ask it to approve')
    expect(wayLabel(candidate({ way: 'code' }))).toBe('Needs a code')
  })

  test('the session host and its own hosts are left out, and only a direct address is offered for pairing', () => {
    const machines = reachableMachines([
      { hostId: 'session', label: 'Mac', routes: [{ kind: 'lan', url: 'http://10.0.0.2:4810' }], isConnected: true, mayReach: true },
      { hostId: 'win', label: 'Windows', routes: [{ kind: 'tunnel', url: 'https://win.solus.dev' }, { kind: 'lan', url: 'http://10.10.1.10:4810' }], isConnected: true, mayReach: true },
      { hostId: 'away', label: 'Away', routes: [{ kind: 'tunnel', url: 'https://away.solus.dev' }], isConnected: false, mayReach: true },
      { hostId: 'guest', label: 'Guest', routes: [{ kind: 'tailnet', url: 'http://100.1.1.1:4810' }], isConnected: true, mayReach: false },
    ], 'session')
    expect(machines).toEqual([
      { serverId: 'win', label: 'Windows', url: 'http://10.10.1.10:4810', canMint: true },
      // A tunnel has no `/pair`: the row has no address and is not offered.
      { serverId: 'away', label: 'Away', url: undefined, canMint: false },
      // Connected without `host.local.reach`: the phone may not make a code there.
      { serverId: 'guest', label: 'Guest', url: 'http://100.1.1.1:4810', canMint: false },
    ])
    const rows = rankAddMachineCandidates({ reason: 'r', hint: 'windows' }, { reachable: machines, ssh: [], nearby: [] })
    expect(rows[0]).toMatchObject({ serverId: 'win', minted: true, isMatch: true })
    expect(rows.some((row) => row.serverId === 'away')).toBe(false)
  })

  test('the selected row decides what Add does, and a refused code asks for approval next', () => {
    const minted = candidate({ way: 'code', minted: true, serverId: 'win', url: 'http://10.10.1.10:4810', label: 'Windows' })
    expect(stepFor(minted, { address: '', useCode: false, mintRefused: NO_REFUSALS })).toEqual({ kind: 'mint', serverId: 'win', url: 'http://10.10.1.10:4810', name: 'Windows' })
    expect(stepFor(minted, { address: '', useCode: false, mintRefused: new Set(['win']) })).toEqual({ kind: 'approve', url: 'http://10.10.1.10:4810', name: 'Windows' })
    expect(stepFor(minted, { address: '', useCode: true, mintRefused: NO_REFUSALS })?.kind).toBe('code')
    const ssh = candidate({ way: 'ssh', sshTarget: 'solus-windows', label: 'solus-windows' })
    expect(stepFor(ssh, { address: '', useCode: false, mintRefused: NO_REFUSALS })).toEqual({ kind: 'ssh', sshTarget: 'solus-windows', name: 'solus-windows' })
    // "Another address…": a bare address gets the Solus port; approval first, a code on request.
    expect(stepFor(null, { address: '10.10.1.10', useCode: false, mintRefused: NO_REFUSALS })).toEqual({ kind: 'approve', url: `http://10.10.1.10:${DEFAULT_SERVER_PORT}`, name: `10.10.1.10:${DEFAULT_SERVER_PORT}` })
    expect(stepFor(null, { address: '10.10.1.10', useCode: true, mintRefused: NO_REFUSALS })?.kind).toBe('code')
    expect(stepFor(null, { address: ' ', useCode: false, mintRefused: NO_REFUSALS })).toBeNull()
  })

  test('a typed value is checked before it can go anywhere: a password is not a code', () => {
    expect(typedCodeValue('Hunter2!')).toBeNull()
    expect(typedCodeError('Hunter2!')).toBe('Enter the 6-digit pairing code, or paste the pair link.')
    expect(typedCodeValue('123 456')).toBe('123456')
    expect(typedCodeError('123 456')).toBeNull()
    expect(typedCodeValue('http://10.0.0.5:4810/#token=abc')).toBe('http://10.0.0.5:4810/#token=abc')
    // An empty field shows no error yet.
    expect(typedCodeError('')).toBeNull()
  })

  test('a check code comes from the secure bytes of the platform, in the unambiguous alphabet', () => {
    const asked: number[] = []
    const code = makeCheckCode((length) => {
      asked.push(length)
      return Uint8Array.from([0, 1, 31, 32, 63, 255, 100, 7])
    })
    expect(asked).toEqual([8])
    expect(code).toBe(`${CHECK_CODE_ALPHABET[0]}${CHECK_CODE_ALPHABET[1]}${CHECK_CODE_ALPHABET[31]}${CHECK_CODE_ALPHABET[0]}-${CHECK_CODE_ALPHABET[31]}${CHECK_CODE_ALPHABET[31]}${CHECK_CODE_ALPHABET[4]}${CHECK_CODE_ALPHABET[7]}`)
    // The host takes it as the person may type it back.
    expect(normalizeCheckCode(code)).toBe(code)
    // Without a platform source, Web Crypto makes it.
    expect(normalizeCheckCode(makeCheckCode())).not.toBeNull()
  })

  test('an approval request shows the time it has left', () => {
    expect(timeLeft(1_000 + 299_000, 1_000)).toBe('4:59 left')
    expect(timeLeft(1_000, 1_000)).toBe('Expired')
  })
})

describe('one tap of Add', () => {
  const listing = (installationId: string, label: string) => ({ id: installationId, installationId, label, routes: [], lastConnected: 0 })

  function deps(session: FakeApi, target: FakeApi | null = null): AddMachineDeps {
    return {
      session: session.surface() as Pick<HostApi, 'hostsAddOverSsh' | 'hostsPair'>,
      target: () => (target ? (target.surface() as Pick<HostApi, 'connectionsGeneratePairToken'>) : null),
      deviceLabel: 'Mac',
    }
  }

  test('SSH that refuses the key asks for a password, then adds with it, and the answer names the way', async () => {
    let tries = 0
    const session = new FakeApi().on('hostsAddOverSsh', () => {
      tries += 1
      return tries === 1
        ? { status: 'needs-auth', sshTarget: 'solus-windows', message: 'SSH refused the key.' }
        : { status: 'forwarded', sessionToken: 't', host: { installationId: 'win', label: 'Windows', sshTarget: 'solus-windows', route: { kind: 'forwarded', url: 'http://127.0.0.1:5000' }, identityKey: 'k', state: 'open', startedBySolus: true } }
    })
    const step: AddMachineStep = { kind: 'ssh', sshTarget: 'solus-windows', name: 'solus-windows' }
    expect(await attemptAddMachine(deps(session), step, { requestId: 'r1' })).toEqual({ kind: 'needs-auth', message: 'SSH refused the key.' })
    const added = await attemptAddMachine(deps(session), step, { requestId: 'r2', authSecret: 'pw' })
    expect(added).toEqual({ kind: 'added', outcome: { status: 'added', installationId: 'win', way: 'ssh' }, label: 'Windows' })
    // No link: the session host holds a forward. The password goes only in the retry.
    expect(session.callsOf('hostsAddOverSsh')).toEqual([
      [{ sshTarget: 'solus-windows', requestId: 'r1', deviceLabel: 'Mac' }],
      [{ sshTarget: 'solus-windows', requestId: 'r2', deviceLabel: 'Mac', authSecret: 'pw' }],
    ])
    if (added.kind !== 'added') throw new Error('expected added')
    // The card's answer carries the outcome, never the password.
    const answers = addMachineOutcomeAnswers(added.outcome)
    expect(JSON.stringify(answers)).not.toContain('pw')
    expect(readAddMachineOutcome(answers)).toEqual({ status: 'added', installationId: 'win', way: 'ssh' })
  })

  test('a code made on a host this phone reaches pairs the session host with it', async () => {
    const session = new FakeApi().on('hostsPair', () => listing('win', 'Windows'))
    const target = new FakeApi().on('connectionsGeneratePairToken', () => ({ token: 'long-token', code: '482913', expiresAt: 0 }))
    const added = await attemptAddMachine(deps(session, target), { kind: 'mint', serverId: 'win', url: 'http://10.10.1.10:4810', name: 'Windows' }, {})
    expect(added).toMatchObject({ kind: 'added', outcome: { way: 'code', installationId: 'win' } })
    expect(session.callsOf('hostsPair')).toEqual([[{ url: 'http://10.10.1.10:4810', code: '482913' }]])
  })

  test('a host that refuses to make a code sends nothing to the session host and offers approval', async () => {
    const session = new FakeApi()
    const target = new FakeApi().on('connectionsGeneratePairToken', () => { throw new Error('only a local connection') })
    const attempt = await attemptAddMachine(deps(session, target), { kind: 'mint', serverId: 'win', url: 'http://10.10.1.10:4810', name: 'Windows' }, {})
    expect(attempt).toMatchObject({ kind: 'failed', mintRefused: 'win' })
    expect(session.calls).toEqual([])
  })

  test('an approval request sends the check code the card shows; a denial keeps the card with its message', async () => {
    const session = new FakeApi().on('hostsPair', () => { throw new Error('The owner of Windows denied the request.') })
    const step: AddMachineStep = { kind: 'approve', url: 'http://10.10.1.10:4810', name: 'Windows' }
    expect(await attemptAddMachine(deps(session), step, { checkCode: 'K7QM-2XFD' })).toEqual({ kind: 'failed', message: 'The owner of Windows denied the request.' })
    expect(session.callsOf('hostsPair')).toEqual([[{ url: 'http://10.10.1.10:4810', checkCode: 'K7QM-2XFD' }]])
    session.on('hostsPair', () => listing('win', 'Windows'))
    expect(await attemptAddMachine(deps(session), step, { checkCode: 'P3RT-8WXY' })).toMatchObject({ kind: 'added', outcome: { way: 'approve' } })
  })

  test('a typed code goes as checked; without one nothing is sent', async () => {
    const session = new FakeApi().on('hostsPair', () => listing('win', 'Windows'))
    const step: AddMachineStep = { kind: 'code', url: 'http://10.10.1.10:4810', name: 'Windows' }
    expect(await attemptAddMachine(deps(session), step, {})).toMatchObject({ kind: 'failed' })
    expect(session.calls).toEqual([])
    expect(await attemptAddMachine(deps(session), step, { code: '123456' })).toMatchObject({ kind: 'added' })
    expect(session.callsOf('hostsPair')).toEqual([[{ url: 'http://10.10.1.10:4810', code: '123456' }]])
  })
})

describe('approval requests on the phone', () => {
  const REQUEST: PairApprovalRequest = { requestId: 'req-1', checkCode: 'K7QM-2XFD', deviceLabel: 'Studio Mac', fromAddress: '10.0.0.7', requestedAt: 1_000, expiresAt: 301_000 }

  async function phoneWith(api: FakeApi, mayReach = true) {
    const world = createHostWorld({ fetch: healthFetch({ 'http://a:1': 'inst-a' }), api: () => api })
    await world.registry.load()
    await world.registry.savePaired({ id: 'inst-a', identityKey: identityKeyFor('inst-a'), label: 'A', url: 'http://a:1' }, 'ta')
    world.connections.connection('inst-a')
    await world.transports[0]?.accept()
    const approvals = new PairApprovals({
      readyConnections: () => world.connections.readyConnections(),
      mayReach: () => mayReach,
      onChange: (listener) => world.connections.changes.subscribe(listener),
    })
    await flushPromises()
    return { world, approvals }
  }

  test('a host lists its open requests, and a new request arrives on the event', async () => {
    const api = new FakeApi().on('hostsPairApprovals', () => [REQUEST])
    const { world, approvals } = await phoneWith(api)
    expect(world.connections.readyConnections().map((connection) => connection.hostId)).toEqual(['inst-a'])
    expect(approvals.open).toEqual([{ hostId: 'inst-a', request: REQUEST }])
    const second = { ...REQUEST, requestId: 'req-2', requestedAt: 2_000 }
    world.transports[0]!.emit('host.pairApprovalsChanged', { approvals: [second, REQUEST] })
    // Oldest first, so the notice asks in the order the machines asked.
    expect(approvals.open.map((entry) => entry.request.requestId)).toEqual(['req-1', 'req-2'])
    expect(approvals.approvalsOf('inst-a')).toEqual([second, REQUEST])
  })

  test('approving sends the decision, and the request leaves the list', async () => {
    const api = new FakeApi().on('hostsPairApprovals', () => [REQUEST]).on('hostsPairApprovalDecide', () => true)
    const { approvals } = await phoneWith(api)
    expect(await approvals.decide('inst-a', 'req-1', 'approve')).toBe(true)
    expect(api.callsOf('hostsPairApprovalDecide')).toEqual([['req-1', 'approve']])
    expect(approvals.open).toEqual([])
    expect(approvals.deciding.size).toBe(0)
  })

  test('a request answered elsewhere also leaves the list', async () => {
    const api = new FakeApi().on('hostsPairApprovals', () => [REQUEST]).on('hostsPairApprovalDecide', () => false)
    const { approvals } = await phoneWith(api)
    expect(await approvals.decide('inst-a', 'req-1', 'deny')).toBe(false)
    expect(approvals.open).toEqual([])
  })

  test('a phone without host.local.reach does not read the requests', async () => {
    const api = new FakeApi().on('hostsPairApprovals', () => [REQUEST])
    const { approvals } = await phoneWith(api, false)
    expect(api.callsOf('hostsPairApprovals')).toEqual([])
    expect(approvals.open).toEqual([])
    await expect(approvals.decide('inst-a', 'req-1', 'approve')).rejects.toThrow('This host cannot be reached now.')
  })

  test('an older host with no approval requests shows none', async () => {
    const api = new FakeApi().on('hostsPairApprovals', () => { throw new Error('unknown method') })
    const { approvals } = await phoneWith(api)
    expect(approvals.open).toEqual([])
  })
})

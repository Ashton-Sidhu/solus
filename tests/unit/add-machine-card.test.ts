import { afterAll, describe, expect, test } from 'bun:test'
import { readAddMachineOutcome } from '@solus/contracts/add-machine'
import type { HostPairRequest } from '@solus/contracts/host-pairing'
import type { HostListing } from '@solus/contracts/host-list'
import type { SshAddProgress, SshAddRequest, SshAddResult } from '@solus/contracts/remote-machines'
import type { AddMachineCandidate } from '@solus/client-core/add-machine-candidates'
import {
  ANOTHER_ADDRESS_KEY,
  addressAttempt,
  candidateAttempt,
  reachableMachines,
  sessionHostDialUrl,
  sshCardOutcome,
  stepTextParts,
  typedCodeAttempt,
  wayLabel,
} from '@solus/workspace-ui/components/conversation/lib/add-machine-card'
import { newCheckCode } from '@solus/workspace-ui/lib/check-code'
import { normalizeCheckCode } from '@solus/contracts/add-machine'

// The card state is a Svelte class; these tests need only its values.
const originalState = Object.getOwnPropertyDescriptor(globalThis, '$state')
Object.defineProperty(globalThis, '$state', { configurable: true, value: <T>(value: T): T => value })
afterAll(() => {
  if (originalState) Object.defineProperty(globalThis, '$state', originalState)
  else Reflect.deleteProperty(globalThis, '$state')
})
const { AddMachineCardState } = await import('@solus/workspace-ui/components/conversation/lib/add-machine-card.svelte')

const windows: AddMachineCandidate = { key: 'ssh:solus-windows', label: 'solus-windows', detail: 'solus-windows · 10.10.1.10', way: 'ssh', minted: false, sshTarget: 'solus-windows', url: 'http://10.10.1.10:4317', isMatch: true }
const studio: AddMachineCandidate = { key: 'host:studio', label: 'Studio', detail: 'http://10.0.0.5:4317', way: 'code', minted: true, url: 'http://10.0.0.5:4317', serverId: 'studio', isMatch: false }
const nearby: AddMachineCandidate = { key: 'nearby:x', label: 'nas', detail: 'http://10.0.0.9:4317', way: 'approve', minted: false, url: 'http://10.0.0.9:4317', isMatch: false }
const listing = (id: string, label: string): HostListing => ({ id, installationId: id, label, routes: [], lastConnected: 1 })

function harness(candidates: AddMachineCandidate[], overrides: Partial<{
  addOverSsh: (request: SshAddRequest) => Promise<SshAddResult>
  pair: (request: HostPairRequest) => Promise<HostListing>
  mint: (serverId: string) => Promise<string>
  passwordIssue: () => string
  watchSshProgress: (requestId: string, onProgress: (progress: SshAddProgress) => void) => () => void
}> = {}) {
  const calls = { ssh: [] as SshAddRequest[], pair: [] as HostPairRequest[], answers: [] as Record<string, string>[], added: [] as string[] }
  const card = new AddMachineCardState({
    candidates: () => candidates,
    addOverSsh: async (request) => { calls.ssh.push({ ...request }); return overrides.addOverSsh ? overrides.addOverSsh(request) : { status: 'linked', installationId: 'win', label: 'Windows' } },
    pair: async (request) => { calls.pair.push({ ...request }); return overrides.pair ? overrides.pair(request) : listing('target', 'Target') },
    watchSshProgress: overrides.watchSshProgress ?? (() => () => {}),
    mint: overrides.mint ?? (async () => '123456'),
    answer: async (answers) => { calls.answers.push(answers); return true },
    passwordIssue: overrides.passwordIssue ?? (() => ''),
    afterSshAdd: async () => {},
    deviceLabel: () => 'This Mac',
    noticeAdded: (label) => { calls.added.push(label) },
  })
  return { card, calls }
}

describe('Add machine card words', () => {
  test('each way reads as the person would say it', () => {
    // WHY: the row tells the person how much the way needs from them before they click Add.
    expect(wayLabel(studio)).toBe('From this device')
    expect(wayLabel(windows)).toBe('Over SSH')
    expect(wayLabel(nearby)).toBe('Ask it to approve')
    expect(wayLabel({ way: 'code', minted: false })).toBe('Needs a code')
  })
})

describe('step text', () => {
  test('a command in backticks is code, without its backticks', () => {
    expect(stepTextParts('Approve it, or run `solus host approve K7QM-2XFD` there.')).toEqual([
      { text: 'Approve it, or run ', isCode: false },
      { text: 'solus host approve K7QM-2XFD', isCode: true },
      { text: ' there.', isCode: false },
    ])
  })
})

describe('the shape check', () => {
  test('a password typed where a code goes is never sent', () => {
    // WHY: rule 1 — the reported incident sent a Windows password to a host over plain HTTP.
    expect(typedCodeAttempt('http://10.10.1.10:4317', 'hunter2!')).toEqual({ error: expect.stringContaining('6-digit'), field: 'code' })
  })

  test('a 6-digit code with spaces goes to the address of the row', () => {
    expect(typedCodeAttempt('http://10.10.1.10:4317', '123 456')).toEqual({ attempt: { way: 'code', url: 'http://10.10.1.10:4317', code: '123456' } })
  })

  test('a pair link carries its own address', () => {
    const link = 'http://10.10.1.10:4317/pair#token=abc'
    expect(typedCodeAttempt(undefined, link)).toEqual({ attempt: { way: 'code', url: 'http://10.10.1.10:4317', code: link } })
  })

  test('a typed address asks for approval; a pasted pair link pairs with its code', () => {
    expect(addressAttempt('10.10.1.10:4317', '', false)).toEqual({ attempt: { way: 'approve', url: 'http://10.10.1.10:4317' } })
    expect(addressAttempt('', '', false)).toEqual({ error: expect.any(String), field: 'address' })
    expect(addressAttempt('http://10.10.1.10:4317/pair#token=abc', '', false)).toMatchObject({ attempt: { way: 'code', url: 'http://10.10.1.10:4317' } })
  })

  test('a row picks the way that needs no typing, unless the person chose a code', () => {
    expect(candidateAttempt(studio, '', false)).toEqual({ attempt: { way: 'minted', url: studio.url!, serverId: 'studio' } })
    expect(candidateAttempt(windows, '', false)).toEqual({ attempt: { way: 'ssh', sshTarget: 'solus-windows' } })
    expect(candidateAttempt(nearby, '654321', true)).toEqual({ attempt: { way: 'code', url: nearby.url!, code: '654321' } })
  })
})

describe('sources', () => {
  test('the session host dials a machine on a route it can reach', () => {
    // WHY: the session host pairs with the target, so a loopback address or another machine's forward reaches nothing.
    expect(sessionHostDialUrl([{ kind: 'lan', url: 'http://127.0.0.1:4317' }, { kind: 'lan', url: 'http://10.0.0.5:4317' }], 'mac')).toBe('http://10.0.0.5:4317')
    expect(sessionHostDialUrl([{ kind: 'forwarded', url: 'http://127.0.0.1:5000', viaHostId: 'other' }], 'mac')).toBeUndefined()
    expect(sessionHostDialUrl([{ kind: 'forwarded', url: 'http://127.0.0.1:5000', viaHostId: 'mac' }], 'mac')).toBe('http://127.0.0.1:5000')
  })

  test('the session host is left out, and only an owner may make a code', () => {
    const rows = reachableMachines([
      { id: 'mac', label: 'Mac', routes: [{ kind: 'lan', url: 'http://10.0.0.2:4317' }], principal: 'local-owner' },
      { id: 'studio', label: 'Studio', routes: [{ kind: 'lan', url: 'http://10.0.0.5:4317' }], principal: 'remote-owner' },
      { id: 'shared', label: 'Shared', routes: [{ kind: 'lan', url: 'http://10.0.0.6:4317' }], principal: 'guest' },
    ], 'mac')
    expect(rows.map((row) => [row.serverId, row.canMint])).toEqual([['studio', true], ['shared', false]])
  })

  test('an SSH needs-auth result asks for a password; a forward is an added machine', () => {
    expect(sshCardOutcome({ status: 'needs-auth', sshTarget: 'win', message: 'SSH refused the key.' }).kind).toBe('ask-password')
    expect(sshCardOutcome({ status: 'needs-target', candidates: [], defaultTarget: '', message: 'Pick one.' })).toEqual({ kind: 'failed', message: 'Pick one.' })
  })

  test('a check code reads back as a check code', () => {
    const code = newCheckCode()
    expect(normalizeCheckCode(code)).toBe(code)
  })
})

describe('the card', () => {
  test('SSH: a refused key asks for a password on the same card, and the password is not kept', async () => {
    let refuse = true
    const { card, calls } = harness([windows], {
      addOverSsh: async () => refuse ? { status: 'needs-auth', sshTarget: 'solus-windows', message: 'SSH refused the key.' } : { status: 'linked', installationId: 'win', label: 'Windows' },
    })
    await card.add()
    expect(card.isPasswordAsked).toBe(true)
    expect(card.failure?.field).toBe('password')
    expect(card.phase).toBe('choose')
    expect(calls.answers).toEqual([])

    refuse = false
    card.password = 'secret-pass'
    await card.add()
    expect(calls.ssh[1].authSecret).toBe('secret-pass')
    expect(card.password).toBe('')
    expect(card.phase).toBe('added')
    // Rule 4: the answer names the outcome only.
    expect(readAddMachineOutcome(calls.answers[0])).toEqual({ status: 'added', installationId: 'win', way: 'ssh' })
    expect(JSON.stringify(calls.answers)).not.toContain('secret-pass')
  })

  test('SSH: a password does not go to a host over an unencrypted connection', async () => {
    const { card, calls } = harness([windows], { passwordIssue: () => 'Connect over HTTPS first.' })
    card.isPasswordAsked = true
    card.password = 'secret-pass'
    await card.add()
    expect(calls.ssh).toEqual([])
    expect(card.password).toBe('')
    expect(card.failure).toEqual({ field: 'password', message: 'Connect over HTTPS first.' })
  })

  test('approve: the check code shows before the host answers, and it is the one sent', async () => {
    let approve!: (value: HostListing) => void
    const { card, calls } = harness([nearby], { pair: () => new Promise((resolve) => { approve = resolve }) })
    const adding = card.add()
    await Promise.resolve()
    expect(card.approval?.checkCode).toBe(calls.pair[0].checkCode!)
    expect(calls.pair[0].code).toBeUndefined()
    approve(listing('nas', 'nas'))
    await adding
    expect(card.approval).toBeNull()
    expect(readAddMachineOutcome(calls.answers[0])).toEqual({ status: 'added', installationId: 'nas', way: 'approve' })
  })

  test('a failure keeps the card open with its message, and the typed code is cleared', async () => {
    // WHY: rule 3 — a wrong code is fixed by typing it again, not by asking the agent again.
    const { card, calls } = harness([nearby], { pair: async () => { throw new Error('The host did not accept the pairing code.') } })
    card.enterCode()
    card.code = '111111'
    await card.add()
    expect(card.phase).toBe('choose')
    expect(card.failure).toEqual({ field: 'code', message: 'The host did not accept the pairing code.' })
    expect(card.code).toBe('')
    expect(calls.answers).toEqual([])
  })

  test('minted: a refused code falls back to an approval request', async () => {
    const { card, calls } = harness([studio], { mint: async () => { throw new Error('refused') } })
    await card.add()
    expect(calls.pair[0].checkCode).toBeDefined()
    expect(readAddMachineOutcome(calls.answers[0])?.status).toBe('added')
    expect(calls.answers[0].way).toBe('approve')
  })

  test('minted: the code made on the target pairs, and the tool hears the code way', async () => {
    const { card, calls } = harness([studio])
    await card.add()
    expect(calls.pair[0]).toEqual({ url: studio.url!, code: '123456' })
    expect(calls.answers[0].way).toBe('code')
    expect(calls.added).toEqual(['Target'])
  })

  test('SSH: the host steps show as a setup card while the add runs, and stay where it stopped when it fails', async () => {
    // WHY: the person must see which step is slow or failed, not one line that each step replaces.
    let report!: (progress: SshAddProgress) => void
    let fail!: (error: Error) => void
    const { card } = harness([windows, nearby], {
      watchSshProgress: (requestId, onProgress) => { report = (progress) => onProgress({ ...progress, requestId }); return () => {} },
      addOverSsh: () => new Promise((_, reject) => { fail = reject }),
    })
    expect(card.statusCard).toBeNull()
    const adding = card.add()
    report({ requestId: '', step: 'connect', message: 'Connecting to solus-windows' })
    report({ requestId: '', step: 'install', message: 'Installing Solus', percent: 40 })
    expect(card.statusCard?.status).toBe('active')
    expect(card.statusCard?.steps.map((step) => [step.id, step.status])).toEqual([['connect', 'done'], ['install', 'active'], ['connected', 'pending']])

    fail(new Error('Port 7420 is in use on the machine.'))
    await adding
    expect(card.phase).toBe('choose')
    expect(card.statusCard?.status).toBe('error')
    expect(card.statusCard?.steps.at(-1)).toEqual({ id: 'install', label: 'Installing Solus', status: 'error', detail: 'Port 7420 is in use on the machine.' })

    // Another machine is a new choice: the old add no longer shows.
    card.select(nearby.key)
    expect(card.statusCard).toBeNull()
  })

  test('a value refused before anything is sent shows at its field, not as a setup card', async () => {
    const { card, calls } = harness([nearby])
    card.enterCode()
    card.code = 'hunter2'
    await card.add()
    expect(calls.pair).toEqual([])
    expect(card.failure?.field).toBe('code')
    expect(card.statusCard).toBeNull()
  })

  test('minted: a code refused by the target turns the setup card into a wait for approval', async () => {
    let approve!: (value: HostListing) => void
    const { card } = harness([studio], { mint: async () => { throw new Error('refused') }, pair: () => new Promise((resolve) => { approve = resolve }) })
    const adding = card.add()
    await Promise.resolve()
    await Promise.resolve()
    expect(card.statusCard?.steps[0]).toEqual({ id: 'approve', label: 'Waiting for approval on Studio', status: 'active' })
    approve(listing('studio', 'Studio'))
    await adding
  })

  test('arrow keys move the selection through the rows to "Another address…"', () => {
    const { card } = harness([windows, nearby])
    expect(card.selectedKey).toBe(windows.key)
    card.move('ArrowDown')
    card.move('ArrowDown')
    expect(card.selectedKey).toBe(ANOTHER_ADDRESS_KEY)
    card.move('ArrowDown')
    expect(card.selectedKey).toBe(windows.key)
  })

  test('decline answers the card as declined', async () => {
    const { card, calls } = harness([windows])
    await card.decline()
    expect(calls.answers).toEqual([{ status: 'declined' }])
    expect(card.phase).toBe('closed')
  })
})

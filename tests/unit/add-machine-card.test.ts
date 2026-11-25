import { afterAll, describe, expect, test } from 'bun:test'
import { readAddMachineOutcome, type AddMachineAsk } from '@solus/contracts/add-machine'
import type { HostPairRequest } from '@solus/contracts/host-pairing'
import type { HostListing } from '@solus/contracts/host-list'
import type { SshAddProgress, SshAddRequest, SshAddResult } from '@solus/contracts/remote-machines'
import type { AddMachineCandidate } from '@solus/client-core/add-machine-candidates'
import {
  ANOTHER_ADDRESS_KEY,
  ANOTHER_SSH_KEY,
  addressAttempt,
  candidateAttempt,
  reachableMachines,
  sessionHostDialUrl,
  sshCardOutcome,
  sshTargetAttempt,
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
  ask: AddMachineAsk
}> = {}) {
  const calls = { ssh: [] as SshAddRequest[], pair: [] as HostPairRequest[], answers: [] as Record<string, string>[], added: [] as string[] }
  const card = new AddMachineCardState({
    candidates: () => candidates,
    ask: () => overrides.ask ?? { reason: 'Add a machine.' },
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
    expect(card.selectedKey).toBe(ANOTHER_SSH_KEY)
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

describe('SSH with a target and a key the person names', () => {
  // A cloud machine is often not in ~/.ssh/config: the person has only its address and the key the console gave.
  const ec2 = { sshTarget: 'ubuntu@3.91.20.4', identityFile: '~/.ssh/aws.pem' }

  test('an SSH target with no value is refused at its field, and a key goes only when it is named', () => {
    expect(sshTargetAttempt('  ', '~/.ssh/aws.pem')).toEqual({ error: 'Enter the SSH target, such as ubuntu@3.91.20.4.', field: 'target' })
    expect(sshTargetAttempt(' ubuntu@3.91.20.4 ', ' ~/.ssh/aws.pem ')).toEqual({ attempt: { way: 'ssh', ...ec2 } })
    expect(sshTargetAttempt('ubuntu@3.91.20.4', '  ')).toEqual({ attempt: { way: 'ssh', sshTarget: 'ubuntu@3.91.20.4' } })
    // A config row sends its alias, with the other key only when the person named one.
    expect(candidateAttempt(windows, '', false, '~/.ssh/win.pem')).toEqual({ attempt: { way: 'ssh', sshTarget: 'solus-windows', identityFile: '~/.ssh/win.pem' } })
    expect(candidateAttempt(windows, '', false)).toEqual({ attempt: { way: 'ssh', sshTarget: 'solus-windows' } })
  })

  test('the card sends the typed target and key to the session host', async () => {
    const { card, calls } = harness([windows])
    card.select(ANOTHER_SSH_KEY)
    card.sshTarget = ec2.sshTarget
    card.identityFile = ec2.identityFile
    await card.add()
    expect(calls.ssh[0]).toMatchObject(ec2)
    expect(readAddMachineOutcome(calls.answers[0])?.status).toBe('added')
  })

  test('the card sends nothing for an empty target', async () => {
    const { card, calls } = harness([])
    card.select(ANOTHER_SSH_KEY)
    await card.add()
    expect(calls.ssh).toEqual([])
    expect(card.failure?.field).toBe('target')
    expect(card.statusCard).toBeNull()
  })

  test('a config row uses its config key until the person asks for another one', async () => {
    // WHY: a key typed for another row must not go to this machine while its field is hidden.
    const { card, calls } = harness([windows])
    card.identityFile = '~/.ssh/other.pem'
    expect(card.showsKeyField).toBe(false)
    await card.add()
    expect(calls.ssh[0].identityFile).toBeUndefined()
  })

  test('the agent\'s target and key fill the card: a typed target opens its own row', () => {
    const { card } = harness([windows, nearby], { ask: { reason: 'Add the EC2 box.', ...ec2 } })
    expect(card.selectedKey).toBe(ANOTHER_SSH_KEY)
    expect(card.sshTarget).toBe(ec2.sshTarget)
    expect(card.identityFile).toBe(ec2.identityFile)
    expect(card.showsKeyField).toBe(true)
  })

  test('the agent\'s target that is a config alias selects that row, with its key field open when a key was named', () => {
    const { card } = harness([nearby, windows], { ask: { reason: 'Add Windows.', sshTarget: 'solus-windows', identityFile: '~/.ssh/win.pem' } })
    expect(card.selectedKey).toBe(windows.key)
    expect(card.isKeyFieldOpen).toBe(true)
    expect(card.showsKeyField).toBe(true)
    // The way back: the config's key again, and no key is sent.
    card.closeKeyField()
    expect(card.identityFile).toBe('')
    expect(card.showsKeyField).toBe(false)
  })

  test('the agent\'s alias selects its row once the config hosts arrive', () => {
    const candidates: AddMachineCandidate[] = []
    const { card } = harness(candidates, { ask: { reason: 'Add Windows.', sshTarget: 'solus-windows' } })
    expect(card.selectedKey).toBe(ANOTHER_SSH_KEY)
    candidates.push(windows)
    expect(card.selectedKey).toBe(windows.key)
    expect(card.isKeyFieldOpen).toBe(false)
  })

  test('a key that others can read is offered a fix, and the fix is the same add, asking the host to fix the key first', async () => {
    // WHY: a key downloaded from a cloud console is often readable by others, and ssh refuses it with an unclear error.
    const { card, calls } = harness([], {
      ask: { reason: 'Add the EC2 box.', ...ec2 },
      addOverSsh: async (request) => request.fixIdentityFilePermissions
        ? { status: 'linked', installationId: 'ec2', label: 'EC2' }
        : { status: 'key-permissions', identityFile: ec2.identityFile, message: 'Other users on Mac can read ~/.ssh/aws.pem, so SSH refuses it.' },
    })
    await card.add()
    expect(calls.ssh[0]?.fixIdentityFilePermissions).toBeUndefined()
    expect(card.keyPermissions).toEqual({ identityFile: ec2.identityFile, message: 'Other users on Mac can read ~/.ssh/aws.pem, so SSH refuses it.' })
    // Nothing was sent, so no setup card shows a failed SSH step.
    expect(card.statusCard).toBeNull()
    expect(card.phase).toBe('choose')
    expect(calls.answers).toEqual([])

    await card.fixKeyPermissions()
    expect(calls.ssh).toHaveLength(2)
    expect(calls.ssh[1]).toMatchObject({ ...ec2, fixIdentityFilePermissions: true })
    expect(card.keyPermissions).toBeNull()
    expect(readAddMachineOutcome(calls.answers[0])).toEqual({ status: 'added', installationId: 'ec2', way: 'ssh' })
  })

  test('a fix the host refuses shows its error, and a later add does not ask for the fix again', async () => {
    const { card, calls } = harness([], {
      ask: { reason: 'Add the EC2 box.', ...ec2 },
      addOverSsh: async (request) => {
        if (request.fixIdentityFilePermissions) throw new Error('~/.ssh/aws.pem belongs to another user, so Solus does not change it.')
        return { status: 'key-permissions', identityFile: ec2.identityFile, message: 'SSH refuses it.' }
      },
    })
    await card.add()
    await card.fixKeyPermissions()
    expect(card.failure?.message).toBe('~/.ssh/aws.pem belongs to another user, so Solus does not change it.')
    expect(card.phase).toBe('choose')
    await card.add()
    expect(calls.ssh.map((request) => request.fixIdentityFilePermissions)).toEqual([undefined, true, undefined])
  })

  test('a key the host does not have shows at the key field, not as a failed add', async () => {
    const { card } = harness([], {
      ask: { reason: 'Add the EC2 box.', ...ec2 },
      addOverSsh: async () => { throw new Error('No file at ~/.ssh/aws.pem on Mac. Choose the private key on Mac.') },
    })
    await card.add()
    expect(card.failure).toEqual({ field: 'identity', message: 'No file at ~/.ssh/aws.pem on Mac. Choose the private key on Mac.' })
    expect(card.statusCard).toBeNull()
  })

  test('the SSH result for a readable key maps to a fix', () => {
    expect(sshCardOutcome({ status: 'key-permissions', identityFile: '~/k.pem', message: 'Refused.' })).toEqual({ kind: 'key-permissions', identityFile: '~/k.pem', message: 'Refused.' })
  })
})

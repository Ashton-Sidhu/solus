import { describe, expect, test } from 'bun:test'
import { rankAddMachineCandidates } from '@solus/client-core/add-machine-candidates'
import { classifyPairSecret } from '@solus/client-core/pairing'
import { addMachineOutcomeAnswers, formatCheckCode, normalizeCheckCode, readAddMachineOutcome } from '@solus/contracts/add-machine'
import { hostPairRequestSchema } from '@solus/contracts/host-pairing'

describe('classifyPairSecret', () => {
  test('a password is not a pairing code, so nothing may be sent', () => {
    expect(classifyPairSecret('hunter2!Windows')).toBeNull()
    expect(classifyPairSecret('12345')).toBeNull()
    expect(classifyPairSecret('1234567')).toBeNull()
  })

  test('a 6-digit code is accepted with the spacing people type', () => {
    expect(classifyPairSecret('123456')).toEqual({ kind: 'code', code: '123456' })
    expect(classifyPairSecret(' 123 456 ')).toEqual({ kind: 'code', code: '123456' })
    expect(classifyPairSecret('123-456')).toEqual({ kind: 'code', code: '123456' })
  })

  test('a pair link carries its own address', () => {
    expect(classifyPairSecret('http://10.10.1.10:3000/pair#token=abc')).toEqual({ kind: 'link', url: 'http://10.10.1.10:3000', pairToken: 'abc' })
  })
})

describe('rankAddMachineCandidates', () => {
  const ask = { url: 'http://10.10.1.10:3000', hint: 'my windows machine', reason: 'Run work there.' }

  test('an SSH alias that resolves to the agent address comes first and keeps the Solus address', () => {
    const rows = rankAddMachineCandidates(ask, {
      reachable: [],
      ssh: [
        { target: 'build-box', label: 'build-box', source: 'ssh-config', hostName: '10.10.1.20' },
        { target: 'solus-windows', label: 'solus-windows', source: 'ssh-config', hostName: '10.10.1.10' },
      ],
      nearby: [],
    })
    expect(rows[0]).toMatchObject({ way: 'ssh', sshTarget: 'solus-windows', url: 'http://10.10.1.10:3000', isMatch: true })
    expect(rows).toHaveLength(2)
  })

  test('a code this client can make beats SSH for the same machine', () => {
    const rows = rankAddMachineCandidates(ask, {
      reachable: [{ serverId: 'win', label: 'sidhu', url: 'http://10.10.1.10:3000', canMint: true }],
      ssh: [{ target: 'solus-windows', label: 'solus-windows', source: 'ssh-config', hostName: '10.10.1.10' }],
      nearby: [],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ way: 'code', minted: true, serverId: 'win' })
  })

  test('an address no source knows is still offered, as an approval request', () => {
    const rows = rankAddMachineCandidates({ url: 'http://10.10.1.99:3000', reason: 'x' }, { reachable: [], ssh: [], nearby: [] })
    expect(rows).toEqual([expect.objectContaining({ way: 'approve', url: 'http://10.10.1.99:3000', isMatch: true })])
  })

  test("the person's words rank a machine with no address match", () => {
    const rows = rankAddMachineCandidates({ hint: 'the windows box', reason: 'x' }, {
      reachable: [],
      ssh: [{ target: 'linux-vm', label: 'linux-vm', source: 'ssh-config' }, { target: 'solus-windows', label: 'solus-windows', source: 'ssh-config' }],
      nearby: [],
    })
    expect(rows.map((row) => [row.sshTarget, row.isMatch])).toEqual([['solus-windows', true], ['linux-vm', false]])
  })
})

describe('add machine contracts', () => {
  test('check codes read unambiguously and normalize as typed', () => {
    const code = formatCheckCode(() => 0)
    expect(code).toBe('2222-2222')
    expect(normalizeCheckCode('k7qm2xfd')).toBe('K7QM-2XFD')
    expect(normalizeCheckCode('K7QM-2XF0')).toBeNull()
  })

  test("the card's answer round-trips and a malformed one is refused", () => {
    const outcome = { status: 'added', installationId: 'win', way: 'ssh' } as const
    expect(readAddMachineOutcome(addMachineOutcomeAnswers(outcome))).toEqual(outcome)
    expect(readAddMachineOutcome({ status: 'added', installationId: 'win', way: 'magic' })).toBeNull()
    expect(readAddMachineOutcome({ status: 'declined' })).toEqual({ status: 'declined' })
  })

  test('hostsPair takes a pairing code or a check code, never both or neither', () => {
    expect(hostPairRequestSchema.safeParse({ url: 'http://x', code: '123456' }).success).toBe(true)
    expect(hostPairRequestSchema.safeParse({ url: 'http://x', checkCode: 'K7QM-2XFD' }).success).toBe(true)
    expect(hostPairRequestSchema.safeParse({ url: 'http://x', code: '123456', checkCode: 'K7QM-2XFD' }).success).toBe(false)
    expect(hostPairRequestSchema.safeParse({ url: 'http://x' }).success).toBe(false)
  })
})

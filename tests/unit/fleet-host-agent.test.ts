import { describe, expect, test } from 'bun:test'
import { fleetMachine, type FleetMachineInput } from '@solus/workspace-ui/components/fleet/lib/fleet-model'
import { hostAgentPrompt, hostAskOf, hostReferenceOf, hostToAskOn } from '@solus/workspace-ui/components/fleet/lib/host-agent'
import { parseReferenceTokens, serializeReferenceToken } from '@solus/workspace-ui/components/editor/reference-tokens'
import { hostReferenceContext, hostReferenceMarkdown, parseHostHref } from '@solus/contracts/host-link'
import { stripInjectedContext } from '@solus/contracts/injected-context'

// WHY: docs/plans/host-fleet.md D12. "Ask an agent" starts a session about a
// host. A session on a host that does not answer never starts, so the choice of
// where it runs decides whether the feature works at all for a host that is
// down. The prompt is what the agent knows: a wrong request or a missing
// address sends it to fix the wrong thing.

const base: FleetMachineInput = {
  serverId: 'h1',
  label: 'studio-mini',
  os: 'linux',
  isThisDevice: false,
  isCloud: false,
  hasManagedCompute: false,
  principal: 'local-owner',
  readiness: 'ready',
  routeKind: 'tailnet',
  address: 'http://100.88.12.4:4317',
  sessions: 0,
  load: { cpu: 20, memory: 40, latencyMs: 4 },
  hasUpdate: false,
  needsSetup: false,
}

describe('where a session about a host runs', () => {
  test('on the host itself when it answers, so the agent works on it in place', () => {
    expect(hostToAskOn([fleetMachine(base)], 'device')).toBe('h1')
    expect(hostToAskOn([fleetMachine({ ...base, sessions: 2 })], 'device')).toBe('h1')
  })

  test('on this device when the host does not answer, because a host that is down cannot run a session', () => {
    for (const readiness of ['unreachable', 'reconnecting', 'checking'] as const) {
      expect(hostToAskOn([fleetMachine({ ...base, readiness })], 'device')).toBe('device')
    }
    expect(hostToAskOn([fleetMachine({ ...base, isCloud: true, hasManagedCompute: true, managedState: 'stopped' })], 'device')).toBe('device')
  })

  test('on this device for several hosts, and the Run on host decides when this client has no device host', () => {
    const two = [fleetMachine(base), fleetMachine({ ...base, serverId: 'h2' })]
    expect(hostToAskOn(two, 'device')).toBe('device')
    expect(hostToAskOn([fleetMachine({ ...base, readiness: 'unreachable' })], undefined)).toBeUndefined()
  })
})

describe('what a session about a host is asked', () => {
  test('the most urgent problem of the host, or a check when it has none', () => {
    expect(hostAskOf(fleetMachine({ ...base, readiness: 'unreachable', hasUpdate: true }))).toBe('unreachable')
    expect(hostAskOf(fleetMachine({ ...base, readiness: 'reconnecting' }))).toBe('reconnecting')
    expect(hostAskOf(fleetMachine({ ...base, needsSetup: true, hasUpdate: true }))).toBe('signin')
    expect(hostAskOf(fleetMachine({ ...base, hasUpdate: true }))).toBe('update')
    expect(hostAskOf(fleetMachine({ ...base, isCloud: true, hasManagedCompute: true, managedState: 'stopped' }))).toBe('stopped')
    expect(hostAskOf(fleetMachine(base))).toBe('check')
  })

  test('the prompt names the host as a chip that carries what Solus knows', () => {
    const prompt = hostAgentPrompt([fleetMachine({ ...base, readiness: 'unreachable' })], 'unreachable')
    expect(prompt).toContain('cannot reach the host [studio-mini](host://ref?')
    expect(prompt).toContain('before you change anything')
    const [chip] = parseReferenceTokens(prompt)
    expect(chip?.token).toEqual({
      kind: 'host',
      serverId: 'h1',
      label: 'studio-mini',
      route: 'Tailscale',
      system: 'linux',
      address: 'http://100.88.12.4:4317',
      state: 'unreachable',
    })
  })

  test('an update asks for no report first', () => {
    const prompt = hostAgentPrompt([fleetMachine({ ...base, hasUpdate: true })], 'update')
    expect(prompt).toContain('Update Solus to the newest version on the host [studio-mini](host://ref?')
    expect(prompt).not.toContain('before you change anything')
  })

  test('one prompt covers the hosts of one "Needs attention" row, with a chip for each', () => {
    const down = ['a', 'b'].map((label) => fleetMachine({ ...base, serverId: label, label, readiness: 'unreachable' }))
    const chips = parseReferenceTokens(hostAgentPrompt(down, 'unreachable'))
    expect(chips.map((chip) => chip.token.kind === 'host' && chip.token.serverId)).toEqual(['a', 'b'])
  })
})

describe('the chip of a host on this client', () => {
  // WHY: this client's id for a host means nothing to another client or to an
  // agent tool. The installation id is the one every side knows, so a chip
  // opens the same host on each client, and an agent can run work there.
  test("names the host by its installation id, and by this client's id only before the host says who it is", () => {
    expect(hostReferenceOf(fleetMachine({ ...base, installationId: 'install-9' })).serverId).toBe('install-9')
    expect(hostReferenceOf(fleetMachine(base)).serverId).toBe('h1')
  })

  test('says whether the host answers, not what runs on it', () => {
    expect(hostReferenceOf(fleetMachine(base)).state).toBe('online')
    expect(hostReferenceOf(fleetMachine({ ...base, sessions: 3 })).state).toBe('online')
    expect(hostReferenceOf(fleetMachine({ ...base, readiness: 'reconnecting' })).state).toBe('reconnecting')
  })
})

describe('a host chip', () => {
  // WHY: the chip is the same text in the composer, in the sent message, and in
  // an agent's reply. A name with brackets, or a link with no server id, must
  // not break the message or name the wrong host.
  test('keeps its host through the link, for a name with brackets too', () => {
    const host = { serverId: 'h1', label: 'build [gpu]', route: 'Solus Cloud · Acme', system: 'linux' as const, address: 'https://h1.example', state: 'idle' }
    const [chip] = parseReferenceTokens(`Check ${hostReferenceMarkdown(host)} now`)
    expect(chip?.token).toEqual({ kind: 'host', ...host })
    expect(serializeReferenceToken(chip!.token)).toBe(hostReferenceMarkdown(host))
  })

  test('a link with no server id is not a host', () => {
    expect(parseHostHref('host://ref?route=Tailscale', 'x')).toBeNull()
    expect(parseHostHref('https://example.com/?serverId=h1', 'x')).toBeNull()
  })
})

describe('what the agent is told about a host the prompt names', () => {
  // WHY: the chip says what a host is. Without this note the agent does not
  // know that it can start work there, or that it already runs on that host,
  // so it tries to reach its own machine over the network or cannot act on
  // another one.
  const studio = hostReferenceMarkdown({ serverId: 'install-1', label: 'studio-mini' })
  const cloud = hostReferenceMarkdown({ serverId: 'install-2', label: 'build [gpu]' })

  test('a host that is not the run host: how to start work on it', () => {
    expect(hostReferenceContext(`Run the tests on ${studio}.`, () => false)).toBe(
      '[Referenced Host: "studio-mini" (host: install-1)]\n'
      + 'The user means this Solus host. It is not the host you run on. To run work on it, give host "install-1" to a session you start with start_sessions.',
    )
  })

  test('the run host: no host is needed', () => {
    const note = hostReferenceContext(`Check ${studio}.`, (host) => host.serverId === 'install-1')
    expect(note).toContain('It is the host you run on')
    expect(note).not.toContain('give host')
  })

  test('one block for each host, once, and none for a prompt that names no host', () => {
    const note = hostReferenceContext(`Compare ${studio} with ${cloud}, then ${studio} again.`, () => false)
    expect(note.match(/^\[Referenced Host:/gm)).toHaveLength(2)
    expect(note).toContain('"build [gpu]" (host: install-2)')
    expect(hostReferenceContext('Fix the login bug in [the docs](https://example.com).')).toBe('')
  })

  test('a client that does not know the run host says how to start work and that the run host needs no host', () => {
    expect(hostReferenceContext(`Check ${studio}.`)).toContain('The host you run on needs no host there.')
  })

  test('a reader of the transcript sees what the person typed, not the note', () => {
    const typed = `Run the tests on ${studio}.`
    expect(stripInjectedContext(`${typed}\n\n${hostReferenceContext(typed, () => false)}`)).toBe(typed)
  })
})

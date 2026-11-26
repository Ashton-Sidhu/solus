import { hostReferenceMarkdown, type HostReference } from '@solus/contracts/host-link'
import { attentionKindOf, hostKindLabel, type AttentionKind, type FleetMachine } from './fleet-model'

/**
 * A session about a host: what the agent is
 * asked, what Solus knows about the host, and the host the session runs on.
 * The person reads the prompt and sends it, so it says nothing they cannot check.
 */

/** What the session is for: the most urgent problem of the host, or a check when it has none. */
export type HostAsk = AttentionKind | 'stopped' | 'check'

export function hostAskOf(machine: FleetMachine): HostAsk {
  return attentionKindOf(machine) ?? (machine.state === 'stopped' ? 'stopped' : 'check')
}

/**
 * The host the session runs on. A host that answers looks at itself: the agent
 * reads its logs and updates it in place. A host that does not answer cannot
 * run a session, and neither can several hosts at once, so the agent works
 * from this device; `undefined` leaves the choice to the Run on host.
 */
export function hostToAskOn(machines: readonly FleetMachine[], deviceServerId: string | undefined): string | undefined {
  const [machine] = machines
  const answers = machine !== undefined && machines.length === 1 && (machine.state === 'running' || machine.state === 'idle')
  return answers ? machine.serverId : deviceServerId
}

/**
 * The chip of a host: its identity, and what Solus knows of it now. The agent
 * reads these facts from the link, and the person sees one chip, not a list.
 * The identity is the host's installation id, which another client and an
 * agent tool (`host` of `start_sessions`) know too; this client's own id for
 * the host is the fallback for a host that has not said who it is.
 */
export function hostReferenceOf(machine: FleetMachine): HostReference {
  const answers = machine.state === 'running' || machine.state === 'idle'
  return {
    serverId: machine.installationId ?? machine.serverId,
    label: machine.label,
    route: hostKindLabel(machine),
    system: machine.os,
    address: machine.address ?? undefined,
    // Sessions come and go; what the agent needs is whether the host answers.
    state: answers ? 'online' : machine.state,
  }
}

/**
 * The prompt of a session about these hosts, each as a host chip. `ask` is the
 * same for all of them: one host from the map, or the hosts of one "Needs
 * attention" row. The prompt is only what the person asks: at send, the
 * composer adds what the agent can do with each host and whether the session
 * runs on it (`hostReferenceContext`).
 */
export function hostAgentPrompt(machines: readonly FleetMachine[], ask: HostAsk): string {
  const chips = machines.map((machine) => hostReferenceMarkdown(hostReferenceOf(machine)))
  const names = chips.length === 1 ? `the host ${chips[0]}` : `these hosts: ${chips.join(', ')}`
  const request = {
    unreachable: `Solus cannot reach ${names}. Find out why, and restore the connection if you can. Tell me what you find before you change anything.`,
    reconnecting: `Solus loses its connection to ${names} again and again. Find out why, and make the connection stable if you can. Tell me what you find before you change anything.`,
    signin: `An agent on ${names} needs a sign-in. Find which agent, and help me sign in.`,
    update: `Update Solus to the newest version on ${names}. Then confirm that Solus runs.`,
    stopped: `Solus shows ${names} as stopped. Find out why, and tell me how to start it again.`,
    check: `Check ${names}: the load, the disk, the Solus version, and anything that needs attention. Report what you find.`,
  } satisfies Record<HostAsk, string>
  return request[ask]
}

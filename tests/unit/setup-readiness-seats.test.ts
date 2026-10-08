import { describe, expect, mock, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import type { Seat, SeatProvider, SeatStatus } from '@solus/contracts/seats'
import type { HostReadiness, SetupAgentAuthCheckResult } from '@solus/contracts/types'
import type { HandlerCtx } from '@solus/server/transport/server'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'
import { installTestIdentities } from './helpers/acting-identities'

// bun has no node:sqlite; the handlers' import chain reaches the db even though
// these tests never open it.
mock.module('node:sqlite', () => ({ DatabaseSync: Database }))

const { registerSetupHandlers } = await import('@solus/server/transport/handlers/setup-handlers')
const { SolusServer } = await import('@solus/server/transport/server')

const MEMBER_ID = 'member-1'

const memberCtx: HandlerCtx = {
  clientId: 'ws:member',
  principal: {
    kind: 'org-member',
    userId: MEMBER_ID,
    organizationId: 'org-1',
    organizationRole: 'owner',
    teamIds: [],
    hostKind: 'managed',
    displayName: 'Member',
    deviceId: 'device-1',
    expiresAt: Date.now() + 60_000,
    deviceLabel: 'Solus cloud',
  },
}

/** Only the member's Claude seat is connected; the host login has nothing. */
function serverWithMemberSeat(): InstanceType<typeof SolusServer> {
  const server = new SolusServer()
  registerSetupHandlers(server, {
    resolveAgentBinary: async () => '/usr/bin/agent',
    hasCommand: () => false,
    projectsRoot: () => '/tmp',
    seats: {
      status: async (seat: Seat, provider: SeatProvider): Promise<SeatStatus> => ({
        provider,
        state: seat.kind === 'user' && seat.userId.kind === 'account' && seat.userId.accountId === MEMBER_ID && provider === 'claude-code' ? 'connected' : 'none',
        usageCapable: false,
      }),
    },
  })
  return server
}

// Members act from homes of their own, as on a booted server (plans/019). The
// member commits as their GitHub account; the host login keeps the host's config.
installTestIdentities({ memberToken: async () => ({ accessToken: 'member-token', login: 'octocat' }) })

describe('setup readiness on a host with seats', () => {
  test('a member signed in to their own seat reads as signed in', async () => {
    // WHY: on a managed host a member signs in to their own seat, not the host
    // login. Readiness that probed the host login kept the onboarding row on
    // "Sign in" after a sign-in that worked, and asked the member to sign in again.
    const server = serverWithMemberSeat()

    const readiness = await server.handle('setupHostReadiness', [], memberCtx) as HostReadiness
    const check = await server.handle('setupCheckAgentAuth', [{ agent: 'claude' }], memberCtx) as SetupAgentAuthCheckResult

    expect(readiness.agents.claude).toEqual({ installed: true, signedIn: true })
    expect(readiness.agents.codex).toEqual({ installed: true, signedIn: false })
    expect(check.authenticated).toBe(true)
  })

  test('another member’s sign-in does not count for the host owner', async () => {
    // WHY: seats are per person; one member's login must not tell the owner
    // (the host login) that the agent is ready for them.
    const server = serverWithMemberSeat()

    const readiness = await server.handle('setupHostReadiness', [], TEST_HANDLER_CTX) as HostReadiness

    expect(readiness.agents.claude.signedIn).toBe(false)
  })

  test('a member’s commit identity is their GitHub account, not the host’s git config', async () => {
    // WHY: a member's commits run with their own GitHub author, so a managed
    // host with no global `user.name` must not report "No commit identity".
    const server = serverWithMemberSeat()

    const readiness = await server.handle('setupHostReadiness', [], memberCtx) as HostReadiness

    expect(readiness.git.identity).toEqual({ name: 'octocat', email: 'octocat@users.noreply.github.com' })
  })
})

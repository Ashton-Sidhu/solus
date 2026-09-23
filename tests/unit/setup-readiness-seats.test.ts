import { describe, expect, test } from 'bun:test'
import type { SeatProvider, SeatStatus } from '@solus/contracts/seats'
import type { HostReadiness, SetupAgentAuthCheckResult } from '@solus/contracts/types'
import { registerSetupHandlers } from '@solus/server/server/handlers/setup-handlers'
import { SolusServer, type HandlerCtx } from '@solus/server/server/server'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'

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
function serverWithMemberSeat(): SolusServer {
  const server = new SolusServer()
  registerSetupHandlers(server, {
    resolveAgentBinary: async () => '/usr/bin/agent',
    hasCommand: () => false,
    projectsRoot: () => '/tmp',
    seats: {
      status: async (userId: string, provider: SeatProvider): Promise<SeatStatus> => ({
        provider,
        state: userId === MEMBER_ID && provider === 'claude-code' ? 'connected' : 'none',
        usageCapable: false,
      }),
    },
  })
  return server
}

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
})

import type { Context, Env, Hono } from 'hono'
import type { TokenVerdict } from '../admission/access-tokens'
import { runnerPrincipalFor, type Principal } from '../admission/principal'
import { createLogger } from '../logger'
import { RUNNER_DELIVER_PATH, runnerDeliverRequestSchema, type RunnerDeliverRequest, type RunnerDeliverResponse } from '../sync/runner-protocol'

const log = createLogger('main', 'runner-routes')

type RunnerPrincipal = Extract<Principal, { kind: 'runner' }>

/** What the Solus API does with one delivered batch (sync/runner-intake.ts). */
export interface RunnerDeliveryIntake {
  deliver: (runner: RunnerPrincipal, request: RunnerDeliverRequest) => Promise<RunnerDeliverResponse>
}

/**
 * The runner route (docs/plans/simplify-auth-and-sync.md §4.5, §4.6): the Solus API
 * only. A host delivers what a person's work produced with that person's delegated
 * token (plans/010-standard-oauth.md): the token names the person and, in `act`,
 * the host acting for them. The body's `hostId` must be that host: a host cannot
 * deliver as another. A host that does not speak this protocol is told to update.
 */
export function registerRunnerRoutes<E extends Env>(app: Hono<E>, opts: {
  isApiMode?: boolean
  runner?: RunnerDeliveryIntake
  verifyAccessToken?: (token: string) => Promise<TokenVerdict>
}): void {
  const { runner, verifyAccessToken } = opts
  if (!opts.isApiMode || !runner) return

  const admitRunner = async (c: Context<E>): Promise<RunnerPrincipal | null> => {
    const header = c.req.header('authorization') ?? ''
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
    if (!bearer || !verifyAccessToken) return null
    const verdict = await verifyAccessToken(bearer)
    if (!verdict.ok) {
      log.info('runner_token_rejected', { reason: verdict.reason })
      return null
    }
    const { claims } = verdict
    // A runner is a host acting for a person in one organization; the Solus API's own delegations name no host.
    if (!claims.act?.host_id || claims.access !== 'org-member') {
      log.info('runner_token_rejected', { reason: !claims.act ? 'not-delegated' : claims.act.host_id ? 'personal-delegation' : 'no-acting-host' })
      return null
    }
    return runnerPrincipalFor({ hostId: claims.act.host_id, organizationId: claims.organizationId, ownerUserId: claims.sub, expiresAt: claims.exp * 1000 })
  }

  app.post(RUNNER_DELIVER_PATH, async (c) => {
    const principal = await admitRunner(c)
    if (!principal) return c.json({ error: 'Unauthorized' }, 401)
    const parsed = runnerDeliverRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid_request' }, 400)
    if (parsed.data.hostId !== principal.hostId) return c.json({ error: 'forbidden' }, 403)
    return c.json(await runner.deliver(principal, parsed.data))
  })
}

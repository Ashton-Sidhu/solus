import type {
  AppContainerAddress,
  AppContainerLogsRequest,
  AppContainerManageAnswer,
  AppContainerManageRequest,
  AppContainerRequest,
  AppContainerRunRequest,
  AppContainerState,
} from '@solus/contracts/app-deployments'
import { APP_MANAGEMENT_SIGNATURE_HEADER } from '@solus/contracts/app-deployments'
import { isHostOwner, type Principal } from '../../admission/principal'
import { createLogger } from '../../logger'
import type { AppPlatform, ManagementFetch } from './app-platform'

const log = createLogger('apps', 'hosted-app-containers.ts')

/** A version that starts applies its migrations. */
const MANAGE_TIMEOUT_MS = 3 * 60_000

/** The platform of this host, with the way to a container that runs. */
export type HostedContainerPlatform = Pick<AppPlatform, 'readiness' | 'run' | 'status' | 'logs' | 'remove'> & {
  /** Where this host reaches the runtime of a container; null when no container of the app runs. */
  origin(appId: string): Promise<string | null>
}

/**
 * The containers this host runs for the apps of another Solus
 * (docs/plans/app-deploy.md §8.5). The owner publishes an app of one host to
 * another host of theirs: that Solus asks this one to run the container, and
 * sends each request of the management API through it. This host knows
 * nothing of the app: it holds no record, no key, and no version. Only the
 * owner of this host asks, because a container is code that runs here.
 */
export class HostedAppContainers {
  constructor(private readonly platform: HostedContainerPlatform, private readonly fetchImpl: ManagementFetch = fetch) {}

  private assertOwner(principal: Principal): void {
    if (principal.kind !== 'system' && !isHostOwner(principal)) throw new Error('Only the owner of this host can run the container of an app on it.')
  }

  async run(principal: Principal, request: AppContainerRunRequest): Promise<AppContainerAddress> {
    this.assertOwner(principal)
    const readiness = await this.platform.readiness(request)
    if (!readiness.ready) throw new Error(readiness.problem)
    const endpoint = await this.platform.run(request)
    log.info('hosted_app_container_started', { appId: request.appId, tailscale: request.tailscaleAddress })
    return { address: endpoint.address }
  }

  async status(principal: Principal, request: AppContainerRequest): Promise<AppContainerState> {
    this.assertOwner(principal)
    return this.platform.status(request.appId)
  }

  async logs(principal: Principal, request: AppContainerLogsRequest): Promise<string> {
    this.assertOwner(principal)
    return this.platform.logs(request.appId, request.lines)
  }

  async remove(principal: Principal, request: AppContainerRequest): Promise<void> {
    this.assertOwner(principal)
    await this.platform.remove(request.appId)
    log.info('hosted_app_container_removed', { appId: request.appId })
  }

  /** Carries one request of the management API to the runtime. The runtime checks the signature; this host adds nothing and reads nothing. */
  async manage(principal: Principal, request: AppContainerManageRequest): Promise<AppContainerManageAnswer> {
    this.assertOwner(principal)
    const origin = await this.platform.origin(request.appId)
    if (!origin) throw new Error('No container of this app runs on this host.')
    const response = await this.fetchImpl(`${origin}${request.path}`, {
      method: request.method,
      // A request with no signature is the runtime's to refuse.
      headers: { 'content-type': 'application/json', [APP_MANAGEMENT_SIGNATURE_HEADER]: request.signature ?? '' },
      body: request.body ?? undefined,
      signal: AbortSignal.timeout(MANAGE_TIMEOUT_MS),
    })
    return { status: response.status, body: await response.text() }
  }
}

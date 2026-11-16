import { APP_MANAGEMENT_SIGNATURE_HEADER, appContainerManageRequestSchema } from '@solus/contracts/app-deployments'
import type { HostApi } from '@solus/client-core/host-api'
import type { AppContainerStatus, AppDeploymentEndpoint, AppDeploymentSpec, AppPlatform, AppPlatformReadiness, ManagementFetch } from './app-platform'

/** A container with a Tailscale address waits for its name on the tailnet. */
const RUN_TIMEOUT_MS = 3 * 60_000
const CALL_TIMEOUT_MS = 30_000

/** What this Solus asks of the host that runs the container. */
export type ContainerHostApi = Pick<HostApi, 'appContainerRun' | 'appContainerStatus' | 'appContainerLogs' | 'appContainerRemove' | 'appContainerManage'>

function within<T>(work: Promise<T>, ms: number, problem: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(problem)), ms)
    signal?.addEventListener('abort', () => reject(new Error(problem)), { once: true })
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

/**
 * The `docker` platform of a connected host (docs/plans/app-deploy.md §8.5):
 * the container of a deployment runs on another host of the owner, and this
 * Solus asks that host for each step. The app, its record, and its key stay
 * here. A request of the management API goes through the same connection,
 * because this Solus does not reach a loopback port of the other host.
 */
export class ConnectedHostPlatform implements AppPlatform {
  readonly kind = 'docker'

  constructor(private readonly label: string, private readonly api: ContainerHostApi) {}

  private ask<T>(what: string, work: Promise<T>, ms = CALL_TIMEOUT_MS, signal?: AbortSignal): Promise<T> {
    return within(work, ms, `${this.label} did not answer ${what} in ${Math.round(ms / 1000)} s.`, signal)
  }

  /** The other host says what it lacks when it runs the container. */
  async readiness(): Promise<AppPlatformReadiness> {
    return { ready: true }
  }

  async run(spec: AppDeploymentSpec): Promise<AppDeploymentEndpoint> {
    const { address } = await this.ask('the run of the container', this.api.appContainerRun({ appId: spec.appId, slug: spec.slug, env: spec.env, tailscaleAddress: spec.tailscaleAddress }), RUN_TIMEOUT_MS)
    // The origin is a name only: each request of the management API goes through `management`.
    return { origin: address, address }
  }

  status(appId: string): Promise<AppContainerStatus> {
    return this.ask('for the state of the container', this.api.appContainerStatus({ appId }))
  }

  logs(appId: string, lines: number): Promise<string> {
    return this.ask('for the log of the container', this.api.appContainerLogs({ appId, lines }))
  }

  async remove(appId: string): Promise<void> {
    await this.ask('the removal of the container', this.api.appContainerRemove({ appId }))
  }

  management(appId: string): ManagementFetch {
    return async (url, init) => {
      const request = appContainerManageRequestSchema.parse({
        appId,
        method: init.method ?? 'GET',
        path: new URL(url).pathname,
        signature: init.headers?.[APP_MANAGEMENT_SIGNATURE_HEADER] ?? null,
        body: init.body ?? null,
      })
      const answer = await this.ask('a request of the deployment', this.api.appContainerManage(request), RUN_TIMEOUT_MS, init.signal)
      return new Response(answer.body, { status: answer.status, headers: { 'content-type': 'application/json' } })
    }
  }
}

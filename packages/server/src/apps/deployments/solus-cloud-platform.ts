import { createLogger } from '../../logger'
import type { AppContainerStatus, AppDeploymentEndpoint, AppDeploymentSpec, AppPlatform, AppPlatformReadiness } from './app-platform'
import type { CloudMachines } from './cloud-machines'

const log = createLogger('apps', 'solus-cloud-platform.ts')

/**
 * The `solus-cloud` platform (docs/plans/app-deploy.md §8.3): the container
 * of a deployment runs on Cloudflare, behind the app Worker of Solus Cloud
 * (`solus-cloud/app-worker`). This adapter asks for a machine with the
 * deployment's env vars. The Worker starts the container for a request and
 * saves its data when it is idle, so a deployment that sleeps still exists
 * and still answers.
 */
export class SolusCloudPlatform implements AppPlatform {
  readonly kind = 'solus-cloud'

  constructor(private readonly machines: CloudMachines) {}

  async readiness(spec: AppDeploymentSpec): Promise<AppPlatformReadiness> {
    if (spec.tailscaleAddress) return { ready: false, problem: 'An app on Solus Cloud has its own address. A Tailscale address is for an app in Docker.' }
    const problem = this.machines.problem()
    return problem === null ? { ready: true } : { ready: false, problem }
  }

  async run(spec: AppDeploymentSpec): Promise<AppDeploymentEndpoint> {
    const { address } = await this.machines.run(spec.appId, spec.slug, spec.env)
    log.info('app_cloud_machine_set', { appId: spec.appId })
    // Solus reaches the management API of the runtime at the same address a browser opens: each request there is signed.
    return { origin: address, address }
  }

  /** Stops the container after a save of its data. The next request starts it again. */
  async stop(appId: string): Promise<void> {
    await this.machines.sleep(appId)
  }

  /** A cloud deployment that sleeps starts for the next request, so it runs for each purpose of Solus while it exists. */
  async status(appId: string): Promise<AppContainerStatus> {
    const exists = await this.machines.exists(appId)
    return { exists, running: exists }
  }

  async logs(): Promise<string> {
    throw new Error('Solus Cloud does not give the log of an app yet.')
  }

  async remove(appId: string): Promise<void> {
    await this.machines.remove(appId)
    log.info('app_cloud_machine_removed', { appId })
  }
}

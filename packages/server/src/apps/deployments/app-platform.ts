import type { AppPlatformKind } from '@solus/contracts/app-deployments'

/**
 * A platform adapter (docs/plans/app-deploy.md §5.4): how one Solus runs the
 * container of a deployment on one kind of place. It runs one container: the
 * runtime image, env vars, a volume for `/data`, and a port. Each container
 * platform can do that, so a new platform is one more of these. The rest of
 * the apps domain knows this interface and nothing of Docker or Cloudflare.
 */

export interface AppDeploymentSpec {
  appId: string
  /** The app's slug, for a name a person reads in the platform's own tools. */
  slug: string
  /** The env vars of the container: the app's own secrets, `SOLUS_URL`, and `SOLUS_APP_KEY`. */
  env: { [name: string]: string }
  /** The sidecar and the address on the tailnet. */
  tailscaleAddress: boolean
}

export interface AppDeploymentEndpoint {
  /** Where this Solus reaches the management API of the deployment. */
  origin: string
  /** The URL where a browser opens the app. On a platform with no address of its own, it is `origin`, which only this host reaches. */
  address: string
}

export type AppPlatformReadiness = { ready: true } | { ready: false; problem: string }

export interface AppContainerStatus {
  /** The platform has the container. */
  exists: boolean
  running: boolean
}

/** One request of the management API of a deployment, as `fetch` takes it. */
export type ManagementFetch = (url: string, init: { method?: string; headers?: { [name: string]: string }; body?: string; signal?: AbortSignal }) => Promise<Response>

export interface AppPlatform {
  readonly kind: AppPlatformKind
  /** Ready, or what is missing: Docker is not running, the image is not there. */
  readiness(spec: AppDeploymentSpec): Promise<AppPlatformReadiness>
  /** Runs the runtime image with its env vars, its volume, and its port. A container of the app that is there already is replaced; its volume stays. */
  run(spec: AppDeploymentSpec): Promise<AppDeploymentEndpoint>
  status(appId: string): Promise<AppContainerStatus>
  /** The newest lines that the container wrote: its log, for the owner. */
  logs(appId: string, lines: number): Promise<string>
  /** Removes the container, the sidecar, the address, and the data. */
  remove(appId: string): Promise<void>
  /** Only on a platform whose containers this Solus does not reach over HTTP: how a request of the management API gets to one. */
  management?(appId: string): ManagementFetch
}

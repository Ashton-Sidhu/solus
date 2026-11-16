import { execFile } from 'node:child_process'
import { createServer, type AddressInfo } from 'node:net'
import { homedir } from 'node:os'
import { z } from 'zod'
import { launchedProcess } from '../../cli-env'
import { createLogger } from '../../logger'
import type { AppContainerStatus, AppDeploymentEndpoint, AppDeploymentSpec, AppPlatform, AppPlatformReadiness } from './app-platform'

const log = createLogger('apps', 'docker-platform.ts')

/**
 * The `docker` platform (docs/plans/app-deploy.md §8.1): one container for
 * each app on the Docker engine of this host, from the `solus-apps-runtime`
 * image. The management API is on a loopback port of the host, so only this
 * host reaches it. The data is a named volume, so a new container of the app
 * is the same app.
 */

const RUNTIME_PORT = 8080
const MEMORY_LIMIT = '1g'
const CPU_LIMIT = '1'
const PROCESS_LIMIT = '256'
/** How long a container has to end its work: the runtime stops its runner and closes its database. */
const STOP_SECONDS = 20
const COMMAND_TIMEOUT_MS = 120_000
/** The first publish on a host downloads the runtime image. */
const PULL_TIMEOUT_MS = 10 * 60_000

/** One `docker` command. `env` adds to the env of the command, for `-e NAME` flags that take their value from it. Rejects with what Docker wrote. */
export type DockerRun = (args: readonly string[], env?: NodeJS.ProcessEnv, timeoutMs?: number) => Promise<string>

/** What the `docker` command gets of the environment: enough to find the engine, and no token of the host's. */
function dockerEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { HOME: homedir() }
  for (const name of ['PATH', 'LANG', 'DOCKER_HOST', 'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'XDG_RUNTIME_DIR', 'SystemRoot', 'USERPROFILE']) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return { ...env, ...extra }
}

const dockerCli: DockerRun = (args, env, timeoutMs = COMMAND_TIMEOUT_MS) => new Promise((resolve, reject) => {
  const launch = launchedProcess({ env: dockerEnvironment(env) }, 'docker', args)
  execFile(launch.file, launch.args, { env: launch.env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(String(stderr).trim().split('\n').pop() || error.message))
    else resolve(String(stdout).trim())
  })
})

/** A TCP port of the loopback interface that nothing listens on now. */
function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      // SAFETY: a listener on a TCP port answers an AddressInfo.
      const { port } = probe.address() as AddressInfo
      probe.close(() => resolve(port))
    })
  })
}

export interface DockerPlatformOptions {
  /** The runtime image, with its tag. */
  image: () => string
  /** The Tailscale auth key of this host, for a deployment with an address on the tailnet (§8.2); null when the host has none. */
  tailscaleAuthKey?: () => string | null
  tailscaleImage?: () => string
  docker?: DockerRun
  freePort?: () => Promise<number>
  /** The wait between two reads of the sidecar's state. */
  wait?: (ms: number) => Promise<void>
  /** The start of each container's name. The containers this host runs for another Solus have their own (§8.5), so the two sets never meet. */
  namePrefix?: string
}

/** What `tailscale serve` does in the sidecar: HTTPS on the node's own name, sent on to the runtime in the same network. */
const SERVE_CONFIG = JSON.stringify({
  TCP: { 443: { HTTPS: true } },
  Web: { '${TS_CERT_DOMAIN}:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${RUNTIME_PORT}` } } } },
})
/** The sidecar writes its serve config from an env var and then starts as the image starts: no file of the host goes into it. */
const SIDECAR_START = 'printf %s "$TS_SERVE_JSON" > /tmp/serve.json && exec /usr/local/bin/containerboot'
const TAILNET_NAME_TIMEOUT_MS = 90_000
const TAILNET_NAME_POLL_MS = 1000

const tailscaleStatusSchema = z.object({ Self: z.object({ DNSName: z.string() }) })

export class DockerPlatform implements AppPlatform {
  readonly kind = 'docker'
  private readonly docker: DockerRun
  private readonly freePort: () => Promise<number>
  private readonly wait: (ms: number) => Promise<void>

  constructor(private readonly options: DockerPlatformOptions) {
    this.docker = options.docker ?? dockerCli
    this.freePort = options.freePort ?? freeLoopbackPort
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** The container of an app. An app id is a name here, so one that is not is refused. */
  private container(appId: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(appId)) throw new Error('This app has no container: its id is not a container name.')
    return `${this.options.namePrefix ?? 'solus-app-'}${appId}`
  }

  private volume(appId: string): string {
    return `${this.container(appId)}-data`
  }

  /** The Tailscale container beside an app's container: the app is one node on the tailnet through it. */
  private sidecar(appId: string): string {
    return `${this.container(appId)}-ts`
  }

  async readiness(spec: AppDeploymentSpec): Promise<AppPlatformReadiness> {
    if (spec.tailscaleAddress && !this.options.tailscaleAuthKey?.()) {
      return { ready: false, problem: 'Solus has no Tailscale auth key on this host. Set SOLUS_TAILSCALE_AUTHKEY for the Solus server, then publish again.' }
    }
    const engine = await this.docker(['version', '--format', '{{.Server.Version}}']).catch(() => null)
    if (!engine) return { ready: false, problem: 'Docker is not running on this host. Start Docker, then publish again.' }
    return { ready: true }
  }

  /** The runtime image, from the registry when this host does not have it. A host keeps the image of each release it published with. */
  private async image(): Promise<string> {
    const image = this.options.image()
    const hasImage = await this.docker(['image', 'inspect', '--format', '{{.Id}}', image]).then(() => true, () => false)
    if (hasImage) return image
    log.info('app_runtime_image_pull', { image })
    await this.docker(['pull', '--quiet', image], undefined, PULL_TIMEOUT_MS).catch((error: Error) => {
      throw new Error(`Docker did not get the image ${image}: ${error.message}. Check the network of this host, or build the image with "bun run build:apps-runtime" and "docker build".`)
    })
    return image
  }

  async run(spec: AppDeploymentSpec): Promise<AppDeploymentEndpoint> {
    const name = this.container(spec.appId)
    const image = await this.image()
    // The containers of an earlier try have the names: they go, and the volumes stay.
    await this.docker(['rm', '--force', name]).catch(() => {})
    await this.docker(['rm', '--force', this.sidecar(spec.appId)]).catch(() => {})
    const port = await this.freePort()
    const labels = ['--label', `sh.solus.app=${spec.appId}`, '--label', `sh.solus.app.slug=${spec.slug}`, '--restart', 'unless-stopped']
    // What this host reaches the runtime at, and the name a container on Linux reaches its host by (Docker Desktop has it already).
    const network = ['--add-host', 'host.docker.internal:host-gateway', '--publish', `127.0.0.1:${port}:${RUNTIME_PORT}`]
    if (spec.tailscaleAddress) await this.runSidecar(spec, labels, network)
    await this.docker([
      'run', '--detach',
      '--name', name,
      ...labels,
      '--memory', MEMORY_LIMIT, '--cpus', CPU_LIMIT, '--pids-limit', PROCESS_LIMIT,
      // With a sidecar, the runtime is in the sidecar's network: the node on the tailnet and the loopback port are the sidecar's.
      ...(spec.tailscaleAddress ? ['--network', `container:${this.sidecar(spec.appId)}`] : network),
      '--volume', `${this.volume(spec.appId)}:/data`,
      // A name with no value takes the value from the env of this command, so no secret is in the argument list.
      ...Object.keys(spec.env).flatMap((variable) => ['--env', variable]),
      image,
    ], spec.env)
    log.info('app_container_started', { appId: spec.appId, port, tailscale: spec.tailscaleAddress })
    const origin = `http://127.0.0.1:${port}`
    return { origin, address: spec.tailscaleAddress ? await this.tailnetAddress(spec.appId) : origin }
  }

  private async runSidecar(spec: AppDeploymentSpec, labels: readonly string[], network: readonly string[]): Promise<void> {
    const sidecar = this.sidecar(spec.appId)
    await this.docker([
      'run', '--detach',
      '--name', sidecar,
      // The name of the node on the tailnet.
      '--hostname', spec.slug,
      ...labels,
      ...network,
      '--volume', `${sidecar}-state:/var/lib/tailscale`,
      '--env', 'TS_STATE_DIR=/var/lib/tailscale', '--env', 'TS_USERSPACE=true', '--env', 'TS_SERVE_CONFIG=/tmp/serve.json',
      '--env', 'TS_AUTHKEY', '--env', 'TS_SERVE_JSON',
      '--entrypoint', '/bin/sh',
      this.options.tailscaleImage?.() ?? 'tailscale/tailscale:stable',
      '-c', SIDECAR_START,
    ], { TS_AUTHKEY: this.options.tailscaleAuthKey?.() ?? '', TS_SERVE_JSON: SERVE_CONFIG })
  }

  /** The address of the app on the tailnet: the name the tailnet gave the sidecar's node. */
  private async tailnetAddress(appId: string): Promise<string> {
    for (let waited = 0; waited <= TAILNET_NAME_TIMEOUT_MS; waited += TAILNET_NAME_POLL_MS) {
      const status = await this.docker(['exec', this.sidecar(appId), 'tailscale', 'status', '--json']).catch(() => null)
      const parsed = status === null ? null : tailscaleStatusSchema.safeParse(JSON.parse(status))
      const name = parsed?.success ? parsed.data.Self.DNSName.replace(/\.$/, '') : ''
      if (name) return `https://${name}`
      await this.wait(TAILNET_NAME_POLL_MS)
    }
    throw new Error('The app did not get a name on the tailnet. Check the Tailscale auth key of this host, and that the tailnet has HTTPS on.')
  }

  async stop(appId: string): Promise<void> {
    await this.docker(['stop', '--time', String(STOP_SECONDS), this.container(appId)])
    await this.docker(['stop', this.sidecar(appId)]).catch(() => {})
  }

  async status(appId: string): Promise<AppContainerStatus> {
    const running = await this.docker(['inspect', '--format', '{{.State.Running}}', this.container(appId)]).catch(() => null)
    return { exists: running !== null, running: running === 'true' }
  }

  /** Where this host reaches the runtime of a container that runs: its loopback port. The sidecar holds the port of a container with a Tailscale address. Null when no container of the app runs. */
  async origin(appId: string): Promise<string | null> {
    for (const name of [this.container(appId), this.sidecar(appId)]) {
      const published = await this.docker(['port', name, `${RUNTIME_PORT}/tcp`]).catch(() => '')
      const port = /^127\.0\.0\.1:(\d+)$/m.exec(published)?.[1]
      if (port) return `http://127.0.0.1:${port}`
    }
    return null
  }

  async logs(appId: string, lines: number): Promise<string> {
    return this.docker(['logs', '--tail', String(lines), this.container(appId)])
  }

  async remove(appId: string): Promise<void> {
    await this.docker(['rm', '--force', this.container(appId)]).catch(() => {})
    await this.docker(['rm', '--force', this.sidecar(appId)]).catch(() => {})
    await this.docker(['volume', 'rm', '--force', this.volume(appId), `${this.sidecar(appId)}-state`])
    log.info('app_container_removed', { appId })
  }
}

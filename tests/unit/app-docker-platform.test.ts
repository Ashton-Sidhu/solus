import { expect, test } from 'bun:test'
import { DockerPlatform, type DockerRun } from '@solus/server/apps/deployments/docker-platform'

/**
 * The docker platform (docs/plans/app-deploy.md §8.1) against a recorded
 * `docker` command: what it asks Docker for. No test here starts a container.
 */

const SPEC = {
  appId: 'a1b2c3d4-0000-4000-8000-000000000001',
  slug: 'notes',
  tailscaleAddress: false,
  env: { SOLUS_APP_KEY: 'sak_secret-key', SOLUS_URL: 'http://host.docker.internal:3000', SOLUS_APP_SECRET_TOKEN: 'the-secret' },
}
const NAME = `solus-app-${SPEC.appId}`

interface Command {
  args: readonly string[]
  env: NodeJS.ProcessEnv | undefined
}

/** A `docker` that records each command and fails the ones whose first words are in `failing`. */
function recorded(failing: readonly string[] = []) {
  const commands: Command[] = []
  const docker: DockerRun = async (args, env) => {
    commands.push({ args, env })
    if (failing.some((start) => args.join(' ').startsWith(start))) throw new Error('docker failed')
    return args[0] === 'inspect' ? 'true' : '27.0.0'
  }
  return { commands, platform: new DockerPlatform({ image: () => 'solus-apps-runtime:1.2.3', docker, freePort: async () => 49200 }) }
}

test('a deployment is one container on a loopback port, with its data in a volume and its secrets out of the argument list', async () => {
  // WHY (§8.1, decision 14): only this host may reach the management API of
  // a deployment, the data must outlive the container, and a secret in an
  // argument is in the process list of the host for each user to read.
  const { commands, platform } = recorded()
  expect(await platform.run(SPEC)).toEqual({ origin: 'http://127.0.0.1:49200', address: 'http://127.0.0.1:49200' })
  const run = commands.find((command) => command.args[0] === 'run')!
  expect(run.args).toContain(NAME)
  expect(run.args.join(' ')).toContain('--publish 127.0.0.1:49200:8080')
  expect(run.args.join(' ')).toContain(`--volume ${NAME}-data:/data`)
  expect(run.args.join(' ')).toContain('--memory 1g')
  expect(run.args.at(-1)).toBe('solus-apps-runtime:1.2.3')
  // Each env var is named, and its value comes from the env of the command.
  expect(run.args.join(' ')).toContain('--env SOLUS_APP_KEY --env SOLUS_URL --env SOLUS_APP_SECRET_TOKEN')
  expect(run.args.join(' ')).not.toContain('the-secret')
  expect(run.args.join(' ')).not.toContain('sak_secret-key')
  expect(run.env).toEqual(SPEC.env)
  // The host has the image, so nothing is pulled. A container of an earlier try goes before the new one; its volume is not touched.
  expect(commands.slice(0, 3).map((command) => command.args.join(' '))).toEqual(['image inspect --format {{.Id}} solus-apps-runtime:1.2.3', `rm --force ${NAME}`, `rm --force ${NAME}-ts`])
  expect(commands.some((command) => command.args[0] === 'volume' || command.args[0] === 'pull')).toBe(false)
})

test('a host that does not have the runtime image pulls it, and a pull that fails leaves the container that runs', async () => {
  // WHY: a release publishes the image, and a host has it only after its first
  // publish. A publish of a new version must not take the running copy down
  // because the registry did not answer.
  const first = recorded(['image inspect'])
  await first.platform.run(SPEC)
  expect(first.commands.map((command) => command.args[0]).slice(0, 3)).toEqual(['image', 'pull', 'rm'])
  expect(first.commands[1]?.args).toEqual(['pull', '--quiet', 'solus-apps-runtime:1.2.3'])

  const offline = recorded(['image inspect', 'pull'])
  await expect(offline.platform.run(SPEC)).rejects.toThrow('Docker did not get the image solus-apps-runtime:1.2.3')
  expect(offline.commands.some((command) => command.args[0] === 'rm' || command.args[0] === 'run')).toBe(false)
})

test('readiness says what is missing before a move stops the app', async () => {
  // WHY: a move stops the app here first. It must not start when the place cannot run it.
  expect(await recorded().platform.readiness(SPEC)).toEqual({ ready: true })
  expect(await recorded(['version']).platform.readiness(SPEC)).toEqual({ ready: false, problem: 'Docker is not running on this host. Start Docker, then publish again.' })
  // A Tailscale address needs the auth key of the host.
  expect(await recorded().platform.readiness({ ...SPEC, tailscaleAddress: true })).toMatchObject({ ready: false, problem: expect.stringContaining('Tailscale auth key') })
})

test('the log is the container\'s own, and remove takes the container and its volume', async () => {
  // WHY: the owner reads what the published copy wrote, and an unpublish must leave no data behind.
  const { commands, platform } = recorded()
  await platform.logs(SPEC.appId, 50)
  expect(commands[0]?.args.join(' ')).toBe(`logs --tail 50 ${NAME}`)
  commands.length = 0
  await platform.remove(SPEC.appId)
  expect(commands.map((command) => command.args.join(' '))).toEqual([`rm --force ${NAME}`, `rm --force ${NAME}-ts`, `volume rm --force ${NAME}-data ${NAME}-ts-state`])
})

test('an app id that is not a name cannot reach the docker command', async () => {
  // WHY: the id is a part of a container name and of a path in the container.
  const { commands, platform } = recorded()
  await expect(platform.stop('../../etc')).rejects.toThrow('its id is not a container name')
  await expect(platform.logs('a b', 10)).rejects.toThrow('its id is not a container name')
  expect(commands).toEqual([])
})

test('with a Tailscale address the app is one node on the tailnet: a sidecar holds the network, and the address is the name the tailnet gave', async () => {
  // WHY (decision 6): the address is the app's own, not the host's, and Solus
  // changes no Tailscale state of the host. The auth key is the host's
  // secret: it must not be in the argument list, and not in the app's container.
  const commands: Command[] = []
  let statusReads = 0
  const docker: DockerRun = async (args, env) => {
    commands.push({ args, env })
    if (args[0] === 'exec' && args.includes('status')) {
      statusReads += 1
      // The node has no name until it joined the tailnet.
      return JSON.stringify({ Self: { DNSName: statusReads < 2 ? '' : 'notes.tail1234.ts.net.' } })
    }
    return '27.0.0'
  }
  const platform = new DockerPlatform({ image: () => 'solus-apps-runtime:1.2.3', docker, freePort: async () => 49200, tailscaleAuthKey: () => 'tskey-auth-secret', wait: async () => {} })
  expect(await platform.readiness({ ...SPEC, tailscaleAddress: true })).toEqual({ ready: true })
  expect(await platform.run({ ...SPEC, tailscaleAddress: true })).toEqual({ origin: 'http://127.0.0.1:49200', address: 'https://notes.tail1234.ts.net' })

  const runs = commands.filter((command) => command.args[0] === 'run')
  const [sidecar, app] = runs
  expect(sidecar?.args.join(' ')).toContain(`--name ${NAME}-ts --hostname notes`)
  expect(sidecar?.args.join(' ')).toContain('--publish 127.0.0.1:49200:8080')
  expect(sidecar?.args.join(' ')).toContain(`--volume ${NAME}-ts-state:/var/lib/tailscale`)
  expect(sidecar?.args.join(' ')).not.toContain('tskey-auth-secret')
  expect(sidecar?.env?.TS_AUTHKEY).toBe('tskey-auth-secret')
  expect(JSON.parse(sidecar?.env?.TS_SERVE_JSON ?? '{}').Web['${TS_CERT_DOMAIN}:443'].Handlers['/'].Proxy).toBe('http://127.0.0.1:8080')
  // The runtime is in the sidecar's network, and it gets no key of Tailscale.
  expect(app?.args.join(' ')).toContain(`--network container:${NAME}-ts`)
  expect(app?.args.join(' ')).not.toContain('--publish')
  expect(app?.env).toEqual(SPEC.env)
})

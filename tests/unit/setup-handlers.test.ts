import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough } from 'stream'
import {
  delegatedCheckoutPath,
  hasClaudeAuth,
  parseAgentSignInVerification,
  probeHostReadiness,
  registerSetupHandlers,
  setupProjectsRoot,
  type SpawnProcess,
} from '../../src/main/server/handlers/setup-handlers'
import {
  agentInstallCompatibilityError,
  applyCloneProtocol,
  buildAgentInstallCommand,
  buildPackageInstallCommand,
  resolveCloneDestination,
  validateCloneUrl,
} from '../../src/main/server/handlers/setup-commands'
import { SolusServer } from '../../src/main/server/server'
import { ClientEventRegistry } from '../../src/main/events/client-event-registry'
import { HostEventPublisher } from '../../src/main/events/host-event-publisher'
import type { SetupCloneProjectResult, SetupPrepareProjectResult, SetupStatusEvent, SetupStepResult } from '../../src/shared/types'

const temporaryDirectories: string[] = []
const resolveTestProjectKey = (path: string) => `project:${path}`

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('projects root', () => {
  test('uses the configured Projects folder and expands it against the host home', () => {
    expect(setupProjectsRoot({ projectsBaseDirectory: '~/Code' }, '/home/dev')).toBe('/home/dev/Code')
  })

  test('falls back to the host home when the setting is unset', () => {
    expect(setupProjectsRoot({}, '/home/dev')).toBe('/home/dev')
  })
})

describe('delegated checkout path', () => {
  test('isolates the same repository by delegated GitHub login', () => {
    // WHY: people sharing a remote host must never share a working tree or see
    // one another's uncommitted work when they dispatch the same repository.
    const octocatPath = delegatedCheckoutPath(
      '/srv/projects',
      'octocat',
      'git@github.com:solus-sh/solus.git',
    )
    const monalisaPath = delegatedCheckoutPath(
      '/srv/projects',
      'monalisa',
      'git@github.com:solus-sh/solus.git',
    )

    expect(octocatPath).toBe('/srv/projects/solus-remote/octocat/solus-sh/solus')
    expect(monalisaPath).not.toBe(octocatPath)
  })

  test('rejects traversal-shaped identity and repository segments', () => {
    expect(() => delegatedCheckoutPath(
      '/srv/projects',
      '../octocat',
      'https://github.com/solus-sh/solus.git',
    )).toThrow('delegated login')
    expect(() => delegatedCheckoutPath(
      '/srv/projects',
      'octocat',
      'https://github.com/.hidden/solus.git',
    )).toThrow('delegated owner')
  })
})

describe('server setup installer command table', () => {
  test('maps agents to fixed official installer argv without client-controlled fragments', () => {
    expect(buildAgentInstallCommand('claude', { hasCommand: () => true })).toEqual({
      command: 'bash',
      args: ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash -s'],
      display: 'curl -fsSL https://claude.ai/install.sh | bash -s',
      strategy: 'claude-install-script',
    })

    expect(buildAgentInstallCommand('codex', { hasCommand: () => true })).toEqual({
      command: 'npm',
      args: ['install', '-g', '@openai/codex'],
      display: 'npm install -g @openai/codex',
      strategy: 'npm',
    })
  })

  test('rejects a KVM CPU profile that cannot run the native Claude binary', () => {
    // WHY: the downloaded executable otherwise spins indefinitely and every
    // retry is reported as "install-claude is already running."
    expect(agentInstallCompatibilityError('claude', {
      platform: 'linux',
      arch: 'x64',
      cpuInfo: 'flags : fpu sse sse2',
    })).toContain('does not expose it')
    expect(agentInstallCompatibilityError('claude', {
      platform: 'linux',
      arch: 'x64',
      cpuInfo: 'flags : fpu sse sse2 sse4_2',
    })).toBeNull()
    expect(agentInstallCompatibilityError('codex', {
      platform: 'linux',
      arch: 'x64',
      cpuInfo: 'flags : fpu sse sse2',
    })).toBeNull()
  })

  test('uses the fixed native Claude installer when npm is unavailable', () => {
    expect(buildAgentInstallCommand('claude', { hasCommand: () => false })).toEqual({
      command: 'bash',
      args: ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash -s'],
      display: 'curl -fsSL https://claude.ai/install.sh | bash -s',
      strategy: 'claude-install-script',
    })

    expect(() => buildAgentInstallCommand('codex', { hasCommand: () => false })).toThrow('npm is required')
  })

  test('runs different agent installers concurrently', async () => {
    // WHY: the onboarding card offers both agents independently, so the host
    // must not reject the second install behind a global setup lock.
    const calls: SpawnCall[] = []
    const server = new SolusServer()
    registerSetupHandlers(server, {
      hasCommand: () => true,
      spawnProcess: processSequence(calls, [{ code: 0 }, { code: 0 }]),
    })

    await Promise.all([
      server.handle('setupInstallAgentCli', [{ agent: 'claude' }], { deviceId: 'test-device' }),
      server.handle('setupInstallAgentCli', [{ agent: 'codex' }], { deviceId: 'test-device' }),
    ])

    expect(calls.map((call) => call.command)).toEqual(['bash', 'npm'])
  })
})

describe('server setup clone URL validation', () => {
  test('accepts well-formed https and ssh git clone URLs', () => {
    expect(validateCloneUrl('https://github.com/solus-sh/solus.git')).toEqual({
      cloneUrl: 'https://github.com/solus-sh/solus.git',
      repoName: 'solus',
    })
    expect(validateCloneUrl('ssh://git@github.com/solus-sh/solus.git')).toEqual({
      cloneUrl: 'ssh://git@github.com/solus-sh/solus.git',
      repoName: 'solus',
    })
    expect(validateCloneUrl('git@github.com:solus-sh/solus.git')).toEqual({
      cloneUrl: 'git@github.com:solus-sh/solus.git',
      repoName: 'solus',
    })
  })

  test('rejects local paths, missing .git suffixes, whitespace, and shell-like suffixes', () => {
    expect(() => validateCloneUrl('file:///tmp/repo.git')).toThrow()
    expect(() => validateCloneUrl('https://github.com/solus-sh/solus')).toThrow()
    expect(() => validateCloneUrl('https://github.com/solus-sh/solus.git --upload-pack=evil')).toThrow()
    expect(() => validateCloneUrl('git@github.com:solus-sh/solus.git;rm -rf /')).toThrow()
  })
})

describe('package install command per platform', () => {
  test('prefers Homebrew, which needs no elevation on either platform', () => {
    expect(buildPackageInstallCommand('git', { platform: 'darwin', hasCommand: (c) => c === 'brew', isRoot: false })).toEqual({
      command: 'brew',
      args: ['install', 'git'],
      display: 'brew install git',
      autoRunnable: true,
    })
    expect(buildPackageInstallCommand('git', { platform: 'linux', hasCommand: (c) => c === 'brew', isRoot: false })?.autoRunnable).toBe(true)
  })

  test('distro managers stay manual when the service account cannot elevate without a prompt', () => {
    expect(buildPackageInstallCommand('git', {
      platform: 'linux',
      hasCommand: (c) => c === 'apt-get',
      isRoot: false,
      canElevate: false,
    })).toEqual({
      command: 'sudo',
      args: ['apt-get', 'install', '-y', 'git'],
      display: 'sudo apt-get install -y git',
      autoRunnable: false,
    })
    expect(buildPackageInstallCommand('git', { platform: 'linux', hasCommand: (c) => c === 'apt-get', isRoot: true })).toEqual({
      command: 'apt-get',
      args: ['install', '-y', 'git'],
      display: 'apt-get install -y git',
      autoRunnable: true,
    })
    expect(buildPackageInstallCommand('git', {
      platform: 'linux',
      hasCommand: (c) => c === 'pacman',
      isRoot: false,
      canElevate: false,
    })?.display)
      .toBe('sudo pacman -S --noconfirm git')
    expect(buildPackageInstallCommand('git', {
      platform: 'linux',
      hasCommand: (c) => c === 'apk',
      isRoot: false,
      canElevate: false,
    })?.display)
      .toBe('sudo apk add git')
  })

  test('runs through non-interactive sudo when the service account can elevate', () => {
    // WHY: remote Solus servers normally run as an unprivileged user. A host
    // with passwordless sudo can still install its own missing prerequisites.
    expect(buildPackageInstallCommand('gh', {
      platform: 'linux',
      hasCommand: (c) => c === 'apt-get',
      isRoot: false,
      canElevate: true,
    })).toMatchObject({
      command: 'sudo',
      display: 'Install gh from GitHub’s official apt repository',
      autoRunnable: true,
    })
    expect(buildPackageInstallCommand('gh', {
      platform: 'linux',
      hasCommand: (c) => c === 'apt-get',
      isRoot: false,
      canElevate: true,
    })?.args.join(' ')).toContain('https://cli.github.com/packages')
  })

  test('macOS falls back to the CLT installer, which Solus cannot drive', () => {
    expect(buildPackageInstallCommand('git', { platform: 'darwin', hasCommand: () => false, isRoot: false })).toEqual({
      command: 'xcode-select',
      args: ['--install'],
      display: 'xcode-select --install',
      autoRunnable: false,
    })
  })

  test('a host with no known installer offers nothing rather than a wrong command', () => {
    expect(buildPackageInstallCommand('git', { platform: 'linux', hasCommand: () => false, isRoot: false })).toBeNull()
  })

  test('the GitHub CLI installs by the same route, under the name each manager knows it by', () => {
    // WHY: `gh` is what the agent opens pull requests with, so a host missing it
    // needs a command that actually resolves — not `pacman -S gh`, which doesn't.
    expect(buildPackageInstallCommand('gh', { platform: 'darwin', hasCommand: (c) => c === 'brew', isRoot: false })?.display)
      .toBe('brew install gh')
    const apt = buildPackageInstallCommand('gh', {
      platform: 'linux',
      hasCommand: (c) => c === 'apt-get',
      isRoot: true,
    })
    expect(apt?.command).toBe('sh')
    expect(apt?.args.join(' ')).toContain('apt-get update')
    expect(apt?.args.join(' ')).toContain('githubcli-archive-keyring.gpg')
    expect(apt?.args.join(' ')).toContain('apt-get install -y gh')
    expect(buildPackageInstallCommand('gh', { platform: 'linux', hasCommand: (c) => c === 'pacman', isRoot: true })?.display)
      .toBe('pacman -S --noconfirm github-cli')
  })

  test('the CLT fallback stays git-only, because nothing in it ships gh', () => {
    expect(buildPackageInstallCommand('gh', { platform: 'darwin', hasCommand: () => false, isRoot: false })).toBeNull()
  })
})

describe('clone protocol selection', () => {
  test('retargets a URL at the chosen protocol so the toggle changes what runs', () => {
    expect(applyCloneProtocol('https://github.com/solus-sh/solus.git', 'ssh')).toBe('git@github.com:solus-sh/solus.git')
    expect(applyCloneProtocol('git@github.com:solus-sh/solus.git', 'https')).toBe('https://github.com/solus-sh/solus.git')
  })

  test('leaves the URL alone when no protocol was chosen', () => {
    expect(applyCloneProtocol('https://github.com/solus-sh/solus.git', undefined))
      .toBe('https://github.com/solus-sh/solus.git')
  })
})

describe('clone destination resolution', () => {
  const projectsRoot = '/srv/solus/projects'

  test('an explicit destination is taken as typed', () => {
    expect(resolveCloneDestination({ destination: '/data/checkouts/solus', repoName: 'solus', projectsRoot }))
      .toBe('/data/checkouts/solus')
  })

  test('falls back under the host projects root, which honours the configured base directory', () => {
    expect(resolveCloneDestination({ repoName: 'solus', projectsRoot, exists: () => false }))
      .toBe('/srv/solus/projects/solus')
  })

  test('never overwrites an existing folder when deriving the name', () => {
    const taken = new Set(['/srv/solus/projects/solus', '/srv/solus/projects/solus-2'])
    expect(resolveCloneDestination({ repoName: 'solus', projectsRoot, exists: (p) => taken.has(p) }))
      .toBe('/srv/solus/projects/solus-3')
  })

  test('returns to the original derived path after its partial checkout is removed', () => {
    let partialExists = true
    const exists = (path: string) => partialExists && path === '/srv/solus/projects/solus'
    expect(resolveCloneDestination({ repoName: 'solus', projectsRoot, exists }))
      .toBe('/srv/solus/projects/solus-2')

    partialExists = false
    expect(resolveCloneDestination({ repoName: 'solus', projectsRoot, exists }))
      .toBe('/srv/solus/projects/solus')
  })

  test('an explicit name wins over the repo name', () => {
    expect(resolveCloneDestination({ name: 'my repo!', repoName: 'solus', projectsRoot, exists: () => false }))
      .toBe('/srv/solus/projects/my-repo')
  })
})

describe('server setup clone dispatch', () => {
  test('refuses delegated preparation without a stable device identity', async () => {
    // WHY: the device id is the key the delegated token is stored under, so an
    // anonymous caller has nowhere to put it — and must not silently fall back
    // to the host's own token, which would push as the wrong identity.
    const server = new SolusServer()
    registerSetupHandlers(server)

    await expect(server.handle('setupPrepareProject', [{
      cloneUrl: 'https://github.com/solus-sh/solus.git',
      credential: { accessToken: 'caller-token', login: 'octocat' },
    }])).rejects.toThrow('Setup actions require an authenticated device.')
  })

  test('the destination host clones when its own project registry has no checkout', async () => {
    // WHY: the client sends only repository intent; checkout discovery and the
    // resulting filesystem action must happen on the destination host.
    const root = await temporaryDirectory()
    const calls: SpawnCall[] = []
    const server = new SolusServer()
    registerSetupHandlers(server, {
      findProjectCheckout: async () => null,
      projectsRoot: () => root,
      loadGithubToken: () => null,
      registerProject: async (path) => resolveTestProjectKey(path),
      spawnProcess: processSequence(calls, [{ code: 0 }]),
    })

    const result = await server.handle('setupPrepareProject', [{
      cloneUrl: 'https://github.com/solus-sh/solus.git',
    }], { deviceId: 'test-device' }) as SetupPrepareProjectResult

    expect(result).toEqual({
      path: join(root, 'solus'),
      projectKey: resolveTestProjectKey(join(root, 'solus')),
      action: 'cloned',
    })
    expect(calls[0].args[0]).toBe('clone')
  })

  test('the destination host validates its matching checkout instead of cloning another', async () => {
    // WHY: a stale or invalid registry path must fail where Host V can explain
    // it; the renderer must not fall back to a second checkout behind its back.
    const checkout = await temporaryDirectory()
    const calls: SpawnCall[] = []
    const server = new SolusServer()
    registerSetupHandlers(server, {
      findProjectCheckout: async () => checkout,
      spawnProcess: processSequence(calls, []),
    })

    await expect(server.handle('setupPrepareProject', [{
      cloneUrl: 'https://github.com/solus-sh/solus.git',
    }], { deviceId: 'test-device' })).rejects.toThrow(`no git checkout at ${checkout}`)
    expect(calls).toEqual([])
  })

  test('derives SSH from the repository, cleans its partial checkout, then falls back to anonymous HTTPS', async () => {
    const root = await temporaryDirectory()
    const destination = join(root, 'solus')
    const calls: SpawnCall[] = []
    const server = new SolusServer()
    registerSetupHandlers(server, {
      loadGithubToken: () => null,
      registerProject: async (path) => resolveTestProjectKey(path),
      spawnProcess: processSequence(calls, [
        {
          code: 128,
          beforeClose(call) {
            const partial = join(String(call.options.cwd), call.args.at(-1)!)
            mkdirSync(partial)
            writeFileSync(join(partial, 'partial'), 'incomplete')
          },
        },
        { code: 0 },
      ]),
    })

    const result = await server.handle('setupCloneProject', [{
      cloneUrl: 'https://github.com/solus-sh/solus.git',
      destination,
    }], { deviceId: 'test-device' }) as SetupCloneProjectResult

    expect(calls.map((call) => call.args[2])).toEqual([
      'git@github.com:solus-sh/solus.git',
      'https://github.com/solus-sh/solus.git',
    ])
    expect(calls[0].options.env?.GIT_SSH_COMMAND)
      .toBe('ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10')
    expect(existsSync(destination)).toBe(false)
    expect(result.auth).toBe('anonymous')
  })

  test('reports token auth only when the HTTPS fallback receives the stored credential helper', async () => {
    const root = await temporaryDirectory()
    const calls: SpawnCall[] = []
    const server = new SolusServer()
    registerSetupHandlers(server, {
      loadGithubToken: () => ({ accessToken: 'secret-token', scope: 'repo', login: 'octocat' }),
      registerProject: async (path) => resolveTestProjectKey(path),
      spawnProcess: processSequence(calls, [{ code: 128 }, { code: 0 }]),
    })

    const result = await server.handle('setupCloneProject', [{
      cloneUrl: 'git@github.com:solus-sh/solus.git',
      destination: join(root, 'solus'),
    }], { deviceId: 'test-device' }) as SetupCloneProjectResult

    expect(result.auth).toBe('token')
    expect(calls[1].options.env?.GIT_ASKPASS).toContain('git-askpass.sh')
    expect(calls[1].options.env?.SOLUS_GIT_PASSWORD).toBe('secret-token')
    expect(calls.flatMap((call) => call.args)).not.toContain('secret-token')
  })

  test('delegated clone uses only HTTPS and feeds the caller token through askpass', async () => {
    const root = await temporaryDirectory()
    const calls: SpawnCall[] = []
    const server = new SolusServer()
    registerSetupHandlers(server, {
      loadGithubToken: () => ({ accessToken: 'host-token', scope: 'repo', login: 'host' }),
      registerProject: async (path) => resolveTestProjectKey(path),
      spawnProcess: processSequence(calls, [{ code: 0 }]),
    })

    const result = await server.handle('setupCloneProject', [{
      cloneUrl: 'git@github.com:solus-sh/solus.git',
      destination: join(root, 'solus'),
      credential: { accessToken: 'caller-token', login: 'octocat' },
    }], { deviceId: 'test-device' }) as SetupCloneProjectResult

    expect(result.auth).toBe('token')
    expect(calls.map((call) => call.args[2])).toEqual(['https://github.com/solus-sh/solus.git'])
    expect(calls[0].options.env?.SOLUS_GIT_PASSWORD).toBe('caller-token')
    expect(calls.flatMap((call) => call.args)).not.toContain('caller-token')
  })

  test('stops after SSH succeeds and honours an explicit HTTPS choice', async () => {
    const sshRoot = await temporaryDirectory()
    const sshCalls: SpawnCall[] = []
    const sshServer = new SolusServer()
    registerSetupHandlers(sshServer, {
      loadGithubToken: () => null,
      registerProject: async (path) => resolveTestProjectKey(path),
      spawnProcess: processSequence(sshCalls, [{ code: 0 }]),
    })

    const sshResult = await sshServer.handle('setupCloneProject', [{
      cloneUrl: 'https://github.com/solus-sh/solus.git',
      destination: join(sshRoot, 'solus'),
    }], { deviceId: 'test-device' }) as SetupCloneProjectResult
    expect(sshResult.auth).toBe('ssh')
    expect(sshCalls).toHaveLength(1)

    const httpsRoot = await temporaryDirectory()
    const httpsCalls: SpawnCall[] = []
    const httpsServer = new SolusServer()
    registerSetupHandlers(httpsServer, {
      loadGithubToken: () => null,
      registerProject: async (path) => resolveTestProjectKey(path),
      spawnProcess: processSequence(httpsCalls, [{ code: 0 }]),
    })
    const httpsResult = await httpsServer.handle('setupCloneProject', [{
      cloneUrl: 'git@github.com:solus-sh/solus.git',
      destination: join(httpsRoot, 'solus'),
      protocol: 'https',
    }], { deviceId: 'test-device' }) as SetupCloneProjectResult

    expect(httpsResult.auth).toBe('anonymous')
    expect(httpsCalls.map((call) => call.args[2])).toEqual(['https://github.com/solus-sh/solus.git'])
  })

  test('clean removes only the partial destination remembered from this handler’s failed clone', async () => {
    const root = await temporaryDirectory()
    const destination = join(root, 'solus')
    const calls: SpawnCall[] = []
    const server = new SolusServer()
    registerSetupHandlers(server, {
      loadGithubToken: () => null,
      registerProject: async (path) => resolveTestProjectKey(path),
      spawnProcess: processSequence(calls, [
        {
          code: 128,
          beforeClose() {
            mkdirSync(destination)
            writeFileSync(join(destination, 'partial'), 'incomplete')
          },
        },
        {
          code: 0,
          onSpawn() {
            expect(existsSync(destination)).toBe(false)
          },
        },
      ]),
    })

    await expect(server.handle('setupCloneProject', [{
      cloneUrl: 'https://github.com/solus-sh/solus.git',
      destination,
      protocol: 'ssh',
    }], { deviceId: 'test-device' })).rejects.toThrow('Exited with code 128')
    expect(existsSync(destination)).toBe(true)

    const result = await server.handle('setupCloneProject', [{
      cloneUrl: 'https://github.com/solus-sh/solus.git',
      destination,
      protocol: 'ssh',
      clean: true,
    }], { deviceId: 'test-device' }) as SetupCloneProjectResult
    expect(result.auth).toBe('ssh')
  })

  test('keeps the process diagnostic with a non-zero exit code', async () => {
    // WHY: package managers reuse exit codes for many failures. The final
    // stderr lines identify whether the user must fix a repository, lock,
    // network, or permissions problem.
    const root = await temporaryDirectory()
    const server = new SolusServer()
    registerSetupHandlers(server, {
      loadGithubToken: () => null,
      spawnProcess: processSequence([], [{
        code: 128,
        stderr: 'fatal: the remote end hung up unexpectedly\n',
      }]),
    })

    await expect(server.handle('setupCloneProject', [{
      cloneUrl: 'https://github.com/solus-sh/solus.git',
      destination: join(root, 'solus'),
      protocol: 'ssh',
    }], { deviceId: 'test-device' })).rejects.toThrow(
      'Exited with code 128:\nfatal: the remote end hung up unexpectedly',
    )
  })

  test('clean removes the remembered partial before resolving a different retry destination', async () => {
    const root = await temporaryDirectory()
    const failedDestination = join(root, 'failed-solus')
    const retryDestination = join(root, 'retry-solus')
    const calls: SpawnCall[] = []
    const server = new SolusServer()
    registerSetupHandlers(server, {
      loadGithubToken: () => null,
      registerProject: async (path) => resolveTestProjectKey(path),
      spawnProcess: processSequence(calls, [
        {
          code: 128,
          beforeClose() {
            mkdirSync(failedDestination)
            writeFileSync(join(failedDestination, 'partial'), 'incomplete')
          },
        },
        {
          code: 0,
          onSpawn() {
            expect(existsSync(failedDestination)).toBe(false)
          },
        },
      ]),
    })

    await expect(server.handle('setupCloneProject', [{
      cloneUrl: 'https://github.com/solus-sh/solus.git',
      destination: failedDestination,
      protocol: 'ssh',
    }], { deviceId: 'test-device' })).rejects.toThrow('Exited with code 128')

    const result = await server.handle('setupCloneProject', [{
      cloneUrl: 'https://github.com/solus-sh/solus.git',
      destination: retryDestination,
      protocol: 'ssh',
      clean: true,
    }], { deviceId: 'test-device' }) as SetupCloneProjectResult

    expect(result.path).toBe(retryDestination)
  })

  test('never removes an existing folder just to make the HTTPS fallback possible', async () => {
    const root = await temporaryDirectory()
    const destination = join(root, 'chosen')
    mkdirSync(destination)
    const calls: SpawnCall[] = []
    const server = new SolusServer()
    registerSetupHandlers(server, {
      loadGithubToken: () => null,
      spawnProcess: processSequence(calls, [{
        code: 128,
        beforeClose() {
          writeFileSync(join(destination, 'partial'), 'incomplete')
        },
      }]),
    })

    await expect(server.handle('setupCloneProject', [{
      cloneUrl: 'https://github.com/solus-sh/solus.git',
      destination,
    }], { deviceId: 'test-device' })).rejects.toThrow('folder already existed')
    expect(existsSync(destination)).toBe(true)
    expect(calls).toHaveLength(1)
  })
})

describe('agent sign-in verification', () => {
  test('parses the current Codex device-flow output', () => {
    const output = `
Follow these steps to sign in with ChatGPT using device code authorization:
1. Open this link in your browser and sign in to your account
https://auth.openai.com/codex/device
2. Enter this one-time code (expires in 15 minutes)
ABCD-EFGH
`
    expect(parseAgentSignInVerification(output)).toEqual({
      url: 'https://auth.openai.com/codex/device',
      code: 'ABCD-EFGH',
    })
  })

  test('unfamiliar output remains a raw-log concern and never throws', () => {
    expect(() => parseAgentSignInVerification('Waiting for browser confirmation…')).not.toThrow()
    expect(parseAgentSignInVerification('Waiting for browser confirmation…')).toBeNull()
  })

  test('parses the native Claude login URL as a code-return prompt', () => {
    // WHY: unlike device auth, Claude sends the browser result back through
    // stdin, so displaying only the URL leaves onboarding stuck forever.
    const output = `
Opening browser to sign in…
If browser didn't open, visit: https://claude.ai/oauth/authorize?code=true&state=abc
Paste code here if prompted >
`
    expect(parseAgentSignInVerification(output)).toEqual({
      url: 'https://claude.ai/oauth/authorize?code=true&state=abc',
      requiresCodeInput: true,
    })
  })

  test('resolves only after the successful process makes Claude auth observable', async () => {
    let hasAuth = false
    const statuses: SetupStatusEvent[] = []
    const calls: SpawnCall[] = []
    const server = new SolusServer()
    const clientEvents = new ClientEventRegistry()
    clientEvents.register('test-client', (event) => {
      if (event.type === 'setup.statusChanged') statuses.push(event.payload)
    })
    registerSetupHandlers(server, {
      events: new HostEventPublisher(clientEvents),
      resolveAgentBinary: () => '/usr/local/bin/claude',
      hasClaudeAuth: () => hasAuth,
      spawnProcess: processSequence(calls, [{
        code: 0,
        stdout: "If browser didn't open, visit: https://claude.ai/oauth/authorize?code=true\n",
        beforeClose() {
          hasAuth = true
        },
      }]),
    })

    const result = await server.handle(
      'setupAgentSignIn',
      [{ agent: 'claude' }],
      { clientId: 'test-client', deviceId: 'test-device' },
    ) as SetupStepResult

    expect(calls[0].command).toBe('claude')
    expect(calls[0].args).toEqual(['auth', 'login'])
    expect(calls[0].options.stdio).toEqual(['pipe', 'pipe', 'pipe'])
    expect(result).toEqual({ step: 'signin-claude', status: 'done', error: undefined })
    expect(statuses).toContainEqual({
      step: 'signin-claude',
      status: 'running',
      verification: {
        url: 'https://claude.ai/oauth/authorize?code=true',
        requiresCodeInput: true,
      },
    })
  })

  test('returns the browser code to the active Claude login over stdin', async () => {
    // WHY: the native Claude login cannot persist credentials until the code
    // shown after browser authorization reaches the waiting host process.
    const calls: SpawnCall[] = []
    const server = new SolusServer()
    registerSetupHandlers(server, {
      resolveAgentBinary: () => '/usr/local/bin/claude',
      hasClaudeAuth: () => false,
      spawnProcess: processSequence(calls, [{ code: 0, waitForKill: true }]),
    })

    const signIn = server.handle(
      'setupAgentSignIn',
      [{ agent: 'claude' }],
      { deviceId: 'test-device' },
    ).catch((error) => error as Error)
    await Promise.resolve()

    let submitted = ''
    calls[0].stdin.on('data', (chunk) => {
      submitted += chunk.toString()
    })
    expect(await server.handle(
      'setupSubmitAgentSignInCode',
      [{ agent: 'claude', code: 'browser-returned-code' }],
      { deviceId: 'test-device' },
    )).toEqual({ submitted: true })
    expect(submitted).toBe('browser-returned-code\n')

    await server.handle('setupCancelAgentSignIn', [], { deviceId: 'test-device' })
    expect((await signIn).message).toBe('Setup step cancelled.')
  })

  test('uses Codex device auth and rejects a zero exit that did not persist sign-in', async () => {
    const calls: SpawnCall[] = []
    const server = new SolusServer()
    registerSetupHandlers(server, {
      resolveAgentBinary: () => '/usr/local/bin/codex',
      hasCodexAuth: () => false,
      spawnProcess: processSequence(calls, [{ code: 0 }]),
    })

    await expect(server.handle(
      'setupAgentSignIn',
      [{ agent: 'codex' }],
      { deviceId: 'test-device' },
    )).rejects.toThrow('Codex is still not signed in on this host')
    expect(calls[0].args).toEqual(['login', '--device-auth'])
  })

  test('cancels an abandoned device-code process so closing onboarding releases the host', async () => {
    // WHY: device auth can wait for 15 minutes. Closing setup must release that
    // process immediately or every later setup action is blocked behind a UI
    // the user can no longer see.
    const calls: SpawnCall[] = []
    const server = new SolusServer()
    registerSetupHandlers(server, {
      resolveAgentBinary: () => '/usr/local/bin/codex',
      hasCodexAuth: () => false,
      spawnProcess: processSequence(calls, [{ code: 0, waitForKill: true }]),
    })

    const signIn = server.handle(
      'setupAgentSignIn',
      [{ agent: 'codex' }],
      { deviceId: 'test-device' },
    ).catch((error) => error as Error)
    await Promise.resolve()

    expect(await server.handle(
      'setupCancelAgentSignIn',
      [],
      { deviceId: 'test-device' },
    )).toEqual({ cancelled: true })
    expect((await signIn).message).toBe('Setup step cancelled.')
    expect(calls[0].killSignals).toEqual(['SIGTERM'])
  })

  test('does not block repository cloning while device sign-in is waiting', async () => {
    // WHY: agent authentication is unrelated to git authentication. A device
    // prompt can wait for 15 minutes without making the host unusable for clone.
    const root = await temporaryDirectory()
    const calls: SpawnCall[] = []
    const server = new SolusServer()
    registerSetupHandlers(server, {
      resolveAgentBinary: () => '/usr/local/bin/codex',
      hasCodexAuth: () => false,
      registerProject: async (path) => resolveTestProjectKey(path),
      spawnProcess: processSequence(calls, [
        { code: 0, waitForKill: true },
        { code: 0 },
      ]),
    })

    const signIn = server.handle(
      'setupAgentSignIn',
      [{ agent: 'codex' }],
      { deviceId: 'test-device' },
    ).catch((error) => error as Error)
    await Promise.resolve()

    const clone = await server.handle('setupCloneProject', [{
      cloneUrl: 'https://github.com/solus-sh/solus.git',
      destination: join(root, 'solus'),
      protocol: 'https',
    }], { deviceId: 'test-device' }) as SetupCloneProjectResult

    expect(clone.auth).toBe('anonymous')
    expect(calls.map((call) => call.command)).toEqual(['codex', 'git'])
    expect(await server.handle(
      'setupCancelAgentSignIn',
      [],
      { deviceId: 'test-device' },
    )).toEqual({ cancelled: true })
    expect((await signIn).message).toBe('Setup step cancelled.')
  })

  test('keeps different agent sign-ins alive at the same time', async () => {
    // WHY: setting up Claude must not replace Codex's device prompt (or vice
    // versa); each agent owns an independent browser-auth lifecycle.
    const calls: SpawnCall[] = []
    const server = new SolusServer()
    registerSetupHandlers(server, {
      resolveAgentBinary: (agent) => `/usr/local/bin/${agent}`,
      hasClaudeAuth: () => false,
      hasCodexAuth: () => false,
      spawnProcess: processSequence(calls, [
        { code: 0, waitForKill: true },
        { code: 0, waitForKill: true },
      ]),
    })

    const claudeSignIn = server.handle(
      'setupAgentSignIn',
      [{ agent: 'claude' }],
      { deviceId: 'test-device' },
    ).catch((error) => error as Error)
    const codexSignIn = server.handle(
      'setupAgentSignIn',
      [{ agent: 'codex' }],
      { deviceId: 'test-device' },
    ).catch((error) => error as Error)
    await Promise.resolve()

    expect(calls.map((call) => call.command)).toEqual(['claude', 'codex'])
    expect(await server.handle(
      'setupCancelAgentSignIn',
      [],
      { deviceId: 'test-device' },
    )).toEqual({ cancelled: true })
    expect((await claudeSignIn).message).toBe('Setup step cancelled.')
    expect((await codexSignIn).message).toBe('Setup step cancelled.')
    expect(calls.map((call) => call.killSignals)).toEqual([['SIGTERM'], ['SIGTERM']])
  })

  test('a new sign-in replaces a stale prompt instead of reporting one already in progress', async () => {
    // WHY: clients can crash or disconnect before sending cancel. Retry itself
    // must be a recovery path rather than relying on perfect renderer cleanup.
    let hasAuth = false
    const calls: SpawnCall[] = []
    const server = new SolusServer()
    registerSetupHandlers(server, {
      resolveAgentBinary: () => '/usr/local/bin/codex',
      hasCodexAuth: () => hasAuth,
      spawnProcess: processSequence(calls, [
        { code: 0, waitForKill: true },
        {
          code: 0,
          beforeClose() {
            hasAuth = true
          },
        },
      ]),
    })

    const staleSignIn = server.handle(
      'setupAgentSignIn',
      [{ agent: 'codex' }],
      { deviceId: 'test-device' },
    ).catch((error) => error as Error)
    await Promise.resolve()

    const retry = await server.handle(
      'setupAgentSignIn',
      [{ agent: 'codex' }],
      { deviceId: 'test-device' },
    )

    expect(retry).toEqual({ step: 'signin-codex', status: 'done', error: undefined })
    expect((await staleSignIn).message).toBe('Setup step cancelled.')
    expect(calls).toHaveLength(2)
    expect(calls[0].killSignals).toEqual(['SIGTERM'])
  })
})

describe('host agent readiness', () => {
  test('uses Claude auth status instead of treating durable client state as a credential', () => {
    // WHY: `~/.claude.json` remains present after `claude auth logout`, so file
    // existence makes Settings claim the host is signed in when it is not.
    const calls: Array<{ command: string; args: string[] }> = []
    const authenticated = hasClaudeAuth((command, args) => {
      calls.push({ command, args })
      return false
    })

    expect(authenticated).toBe(false)
    expect(calls).toEqual([{ command: 'claude', args: ['auth', 'status'] }])
  })

  test('reports both installed agents and their local sign-in state', () => {
    const readiness = probeHostReadiness(() => false, {
      resolveAgentBinary: () => '/usr/local/bin/agent',
      hasClaudeAuth: () => true,
      hasCodexAuth: () => true,
    })
    expect(readiness.agents).toEqual({
      claude: { installed: true, signedIn: true },
      codex: { installed: true, signedIn: true },
    })
  })

  test('does not claim sign-in when either agent binary is missing', () => {
    const readiness = probeHostReadiness(() => false, {
      resolveAgentBinary: () => null,
      hasClaudeAuth: () => true,
      hasCodexAuth: () => true,
    })
    expect(readiness.agents).toEqual({
      claude: { installed: false, signedIn: false },
      codex: { installed: false, signedIn: false },
    })
  })
})

describe('adopting an existing checkout', () => {
  test('registers an origin that identifies the same repository through a different protocol', async () => {
    const checkout = await gitCheckout('git@github.com:solus-sh/solus.git')
    const recorded: string[] = []
    const server = new SolusServer()
    registerSetupHandlers(server, {
      registerProject: async (path) => {
        recorded.push(path)
        return resolveTestProjectKey(path)
      },
    })

    const result = await server.handle('setupAdoptProject', [{
      path: checkout,
      cloneUrl: 'https://github.com/solus-sh/solus.git',
    }], { deviceId: 'test-device' }) as { path: string; projectKey: string }

    expect(result.path).toBe(checkout)
    expect(result.projectKey).toBeString()
    expect(recorded).toEqual([checkout])
  })

  test('names the unrelated origin instead of silently registering the wrong repository', async () => {
    const checkout = await gitCheckout('https://github.com/other/project.git')
    const server = new SolusServer()
    registerSetupHandlers(server)

    await expect(server.handle('setupAdoptProject', [{
      path: checkout,
      cloneUrl: 'https://github.com/solus-sh/solus.git',
    }], { deviceId: 'test-device' })).rejects.toThrow('origin https://github.com/other/project.git')
  })

  test('names the folder when there is no git checkout to adopt', async () => {
    const folder = await temporaryDirectory()
    const server = new SolusServer()
    registerSetupHandlers(server)

    await expect(server.handle(
      'setupAdoptProject',
      [{ path: folder }],
      { deviceId: 'test-device' },
    )).rejects.toThrow(`no git checkout at ${folder}`)
  })
})

interface SpawnCall {
  command: string
  args: string[]
  options: Parameters<SpawnProcess>[2]
  killSignals: NodeJS.Signals[]
  stdin: PassThrough
}

interface ProcessOutcome {
  code: number
  stdout?: string
  stderr?: string
  waitForKill?: boolean
  onSpawn?(call: SpawnCall): void
  beforeClose?(call: SpawnCall): void
}

function processSequence(calls: SpawnCall[], outcomes: ProcessOutcome[]): SpawnProcess {
  return (command, args, options) => {
    const stdin = new PassThrough()
    const call: SpawnCall = { command, args, options, killSignals: [], stdin }
    calls.push(call)
    const outcome = outcomes[calls.length - 1]
    if (!outcome) throw new Error(`Unexpected process ${command} ${args.join(' ')}`)
    outcome.onSpawn?.(call)
    const child = new EventEmitter() as ChildProcess
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    child.stdin = stdin
    child.stdout = stdout
    child.stderr = stderr
    let closed = false
    const close = (code: number | null, signal: NodeJS.Signals | null = null) => {
      if (closed) return
      closed = true
      outcome.beforeClose?.(call)
      if (outcome.stdout) stdout.end(outcome.stdout)
      else stdout.end()
      if (outcome.stderr) stderr.end(outcome.stderr)
      else stderr.end()
      child.emit('close', code, signal)
    }
    child.kill = ((signal: NodeJS.Signals = 'SIGTERM') => {
      call.killSignals.push(signal)
      queueMicrotask(() => close(null, signal))
      return true
    }) as ChildProcess['kill']
    if (!outcome.waitForKill) {
      queueMicrotask(() => close(outcome.code))
    }
    return child
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'solus-setup-test-'))
  temporaryDirectories.push(directory)
  return directory
}

async function gitCheckout(origin: string): Promise<string> {
  const checkout = await temporaryDirectory()
  execFileSync('git', ['init', checkout], { stdio: 'ignore' })
  execFileSync('git', ['-C', checkout, 'remote', 'add', 'origin', origin], { stdio: 'ignore' })
  return checkout
}

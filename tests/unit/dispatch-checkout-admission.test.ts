import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { execFileSync, spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from './helpers/bun-sqlite'
import type { IpcContext } from '@solus/contracts/types'
import type { SessionRunRequest } from '@solus/server/execution/session-runtime'
import type { HostOrganizationsResponse, HostRegistration } from '@solus/contracts/uplink'

mock.module('node:sqlite', () => ({ DatabaseSync }))

// A Run on send names its repository; the folder the client sends is a path on
// the client, or `~` (docs/run-on.md). On a machine attached for organization
// work, the owner claim, the turn admission, and the first facts the Solus API
// records all happen before the copy. They must name the folder the host copies
// to, never the client's path, and the copy must land in that same folder.

type Principal = import('@solus/server/admission/principal').Principal
type Handler = (args: unknown[], handlerCtx: { principal: Principal; clientId?: string; deviceId?: string }) => Promise<unknown>

const previousDataDir = process.env.SOLUS_DATA_DIR
const base = realpathSync(mkdtempSync(join(tmpdir(), 'solus-dispatch-checkout-admission-')))
const CLONE_URL = 'https://github.com/owner/repo.git'
const CLONE_ATTEMPTS = new Set([CLONE_URL, 'git@github.com:owner/repo.git'])
const ISOLATED = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
}
const LINK: HostRegistration = { hostId: 'VM', issuer: 'https://cloud.invalid', jwksUrl: 'https://cloud.invalid/jwks', directoryUrl: 'https://cloud.invalid', generation: 1, apiUrl: 'https://api.invalid' }
const STANDING: HostOrganizationsResponse = {
  hostId: 'VM',
  category: 'self-hosted',
  owner: { userId: 'alice', email: 'alice@example.test', name: 'Alice' },
  organizations: [{ organizationId: 'A', name: 'Acme', shared: true, policy: { allowsCloudHosts: true, allowsPersonalHosts: false, syncAllInsights: true } }],
}
const ALICE: Principal = { kind: 'owner', via: 'grant', userId: 'alice', deviceId: 'account-session', expiresAt: Date.now() + 600_000, deviceLabel: 'Solus cloud' }

let remote = ''
let hostCategory: typeof import('@solus/server/host/host-category')
let attachment: typeof import('@solus/server/host/organization-attachment')

function fixtureGit(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, env: ISOLATED, stdio: 'ignore' })
}

beforeAll(async () => {
  process.env.SOLUS_DATA_DIR = join(base, 'data')
  const { installTestIdentities } = await import('./helpers/acting-identities')
  installTestIdentities()
  const source = join(base, 'source')
  fixtureGit(['init', '-q', '-b', 'main', source], base)
  writeFileSync(join(source, 'README.md'), 'hello\n')
  fixtureGit(['add', 'README.md'], source)
  fixtureGit(['commit', '-q', '-m', 'Initial'], source)
  remote = join(base, 'remote.git')
  fixtureGit(['clone', '-q', '--bare', source, remote], base)
  hostCategory = await import('@solus/server/host/host-category')
  attachment = await import('@solus/server/host/organization-attachment')
  const insightMirror = await import('@solus/server/sync/mirror/insight-mirror')
  insightMirror.useInsightsPolicy({ syncAllInsights: () => null, optedIn: () => false, attached: () => false })
  // A customer's own VM, attached for organization work.
  hostCategory.resetHostCategoryForTests()
  hostCategory.applyHostCategory('self-hosted')
  attachment.useOrganizationAttachment(() => 1_000)
})

afterAll(async () => {
  hostCategory.resetHostCategoryForTests()
  attachment.useOrganizationAttachment(() => null)
  const { closeDatabase } = await import('@solus/server/db/database')
  const { closeDb } = await import('@solus/server/db')
  await closeDatabase()
  closeDb()
  rmSync(base, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.SOLUS_DATA_DIR
  else process.env.SOLUS_DATA_DIR = previousDataDir
})

async function harness() {
  const { registerSessionHandlers } = await import('@solus/server/transport/handlers/session-handlers')
  const { registerSetupHandlers } = await import('@solus/server/transport/handlers/setup-handlers')
  const { SolusServer } = await import('@solus/server/transport/server')
  const { PromptDispatch } = await import('@solus/server/execution/sessions/prompt-dispatch')
  const { HostOrganizations } = await import('@solus/server/host/organizations')
  const { ShareManager } = await import('@solus/server/sharing/share-manager')
  const { getDatabase } = await import('@solus/server/db/database')
  const { withActor } = await import('./helpers/actors')

  const shares = new ShareManager({ db: getDatabase() })
  const hostOrganizations = new HostOrganizations({
    registration: () => LINK,
    credential: () => ({ hostAccessToken: async () => 'control-token' }),
    fetchImpl: async () => new Response(JSON.stringify(STANDING), { status: 200, headers: { 'content-type': 'application/json' } }),
    setTimeoutFn: (() => ({ unref() {} })) as unknown as typeof setTimeout,
    clearTimeoutFn: (() => {}) as typeof clearTimeout,
  })
  await hostOrganizations.refresh()

  const setup = registerSetupHandlers(new SolusServer(), {
    projectsRoot: () => join(base, 'projects'),
    registerProject: async (path) => path,
    loadGithubToken: async () => null,
    hasCommand: () => false,
    spawnProcess: (file, args, options) => nodeSpawn(file, args.map((arg) => CLONE_ATTEMPTS.has(arg) ? `file://${remote}` : arg), { ...options, env: { ...ISOLATED, ...options.env } }),
  })

  /** What the Solus API was asked, with the first facts it records. */
  const admissions: Array<{ sessionId: string; record?: { cwd: string | null; projectPath: string; privateToOwner: boolean } }> = []
  /** The runs that reached the launcher, after admission. */
  const runs: SessionRunRequest[] = []
  const rt = {
    activeSessions: new Map(),
    agentSessionToSession: new Map(),
    assertNewWorkAllowed: () => {},
    seatForTurn: async () => null,
    sessionOfThread: () => undefined,
    sessionIdForCtx: (ctx: IpcContext) => ctx.session.sessionId,
    launcher: { failedSetupPrompts: new Map() },
    statuses: { setStatus: () => {} },
    runTurn: async (request: SessionRunRequest) => {
      runs.push(request)
      return { disposition: 'started', agentSessionId: Promise.resolve({ agentSessionId: null }) }
    },
  }
  const dispatch = new PromptDispatch(rt as never)
  dispatch.admission = {
    hostOrganizations,
    delegations: { actFor: async (input: (typeof admissions)[number]) => { admissions.push(input) } } as never,
    adoptSession: (sessionId, organizationId, ownerKey, options) => shares.adoptForOrganization({ kind: 'session', id: sessionId }, organizationId, ownerKey, options),
  }
  const handlers = new Map<string, Handler>()
  registerSessionHandlers(
    { register: (name: string, handler: Handler) => handlers.set(name, (args, handlerCtx) => handler(args, withActor(handlerCtx))) } as never,
    {
      sessionRuntime: {
        activeSessions: rt.activeSessions,
        dispatch,
        watchers: { watches: new Map(), watchSession: () => {} },
        launcher: { dispatchCheckoutPathOf: setup.dispatchCheckoutPathOf },
      } as never,
      orchestrator: { mayAnswer: () => true },
      agentIdFromContext: () => 'codex',
      shares,
    },
  )
  /** A Run on send from a paired laptop, in the owner's window for organization A. */
  const sendRunOn = (sessionId: string, clientFolder: string, method: 'prompt' | 'retry' = 'prompt') => {
    const ctx = {
      session: {
        sessionId, organizationId: 'A', provider: 'codex', agentSessionId: null, status: 'idle',
        workingDirectory: clientFolder, projectPath: clientFolder, additionalDirs: [],
        gitContext: { branch: 'main', targetBranch: 'main', repoRoot: clientFolder, worktreePath: clientFolder },
        worktreeBaseBranch: null, preferredModel: 'gpt-requested', reasoningEffort: 'medium', contextWindow: null,
        fastMode: false, permissionMode: 'supervised', readOnlyReason: null,
        repository: { cloneUrl: CLONE_URL, newWorktree: true },
      },
      settings: { activeAgent: 'codex' },
      statusBar: { model: 'gpt-requested', reasoningEffort: 'medium', fastMode: false },
    } as unknown as IpcContext
    return handlers.get(method)!([ctx, { prompt: 'Go.' }], { principal: ALICE, clientId: 'ws:laptop', deviceId: 'laptop-1' })
  }
  return { setup, shares, admissions, runs, sendRunOn, rt }
}

describe('a Run on send on a machine attached for organization work', () => {
  test('is admitted and recorded in the host\'s dispatch checkout folder, and the copy lands in that folder', async () => {
    const { setup, shares, admissions, runs, sendRunOn } = await harness()
    const checkoutPath = join(base, 'projects', 'solus-remote', 'laptop-1', 'github.com', 'owner', 'repo')

    await sendRunOn('s-run-on', '/Users/someone/solus')

    // WHY: the API records the session's first facts at admission, before the
    // copy. A client path names a folder this host does not have.
    expect(admissions).toHaveLength(1)
    expect(admissions[0].record).toMatchObject({ cwd: checkoutPath, privateToOwner: false })
    expect(JSON.stringify(admissions[0])).not.toContain('/Users/someone')
    // The claim read the same folder: a project, so the organization gets its grant.
    expect((await shares.homeOf({ kind: 'session', id: 's-run-on' }))?.ownerKey).toBe('alice')
    // The run starts from the host's folder too; the client's checkout view is dropped.
    expect(runs).toHaveLength(1)
    expect(runs[0].input.workingDirectory).toBe(checkoutPath)
    expect(runs[0].input.projectPath).toBe(checkoutPath)
    expect(runs[0].input.gitContext).toBeNull()

    // The copy the launcher asks for later lands where admission said it would.
    expect(existsSync(checkoutPath)).toBe(false)
    const repositoryRun = runs[0].repository!
    const { withUserScope } = await import('@solus/server/vault/acting-scope')
    const prepared = await withUserScope(null, () => setup.prepareDispatchCheckout(repositoryRun.repository, { principal: ALICE, deviceId: repositoryRun.deviceId }, { onOutput: () => {}, signal: new AbortController().signal }))
    expect(prepared).toBe(checkoutPath)
    expect(existsSync(join(checkoutPath, 'README.md'))).toBe(true)
  })

  test('a client that sends `~` gets the same host folder', async () => {
    const { admissions, runs, sendRunOn } = await harness()
    await sendRunOn('s-run-on-home', '~')
    const checkoutPath = join(base, 'projects', 'solus-remote', 'laptop-1', 'github.com', 'owner', 'repo')
    expect(admissions[0].record?.cwd).toBe(checkoutPath)
    expect(runs[0].input.workingDirectory).toBe(checkoutPath)
  })

  test('a retry of a dead session still makes the copy', async () => {
    // WHY: a launch that died before its copy leaves no checkout. The retry
    // starts a new provider session, and it must carry the repository too.
    const { rt, runs, sendRunOn } = await harness()
    rt.activeSessions.set('s-run-on-dead', { status: 'dead', agentSessionId: 'old-thread' })
    await sendRunOn('s-run-on-dead', '~', 'retry')
    const checkoutPath = join(base, 'projects', 'solus-remote', 'laptop-1', 'github.com', 'owner', 'repo')
    expect(runs).toHaveLength(1)
    expect(runs[0].target).toEqual({ kind: 'new-session' })
    expect(runs[0].repository?.repository.cloneUrl).toBe(CLONE_URL)
    expect(runs[0].input.workingDirectory).toBe(checkoutPath)
  })
})

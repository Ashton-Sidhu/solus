import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { IpcContext, SessionCtx, SettingsCtx, StatusBarCtx } from '@solus/contracts/types'
import { LabClient } from '../src/client'
import { bootLabHost, type LabHost } from '../src/host'
import { recordedRuns } from '../src/oracle'
import { ORGANIZATION_ID, PERSONAS, personaForHost } from '../src/personas'
import { expectOk, expectRefused, scenario, type ScenarioContext } from '../src/scenario'

/**
 * Member users (docs/plans/member-isolation.md §4, §8.1, §8.3): on a managed host
 * each member runs as the Linux user the host object made and listed in the users
 * file. The Lab plays the host object: it writes the file as the host object's
 * script would, last and by rename. Every Lab host runs as the developer's own
 * user, so each member's uid here is that user's: a switch to it needs no
 * privilege, and the run still proves the uid came from the file. Real uids,
 * folder owners, and modes are the container proof's (step 6).
 *
 * bob is not in the file: he connects, sees that his workspace is being set up,
 * and his turn is refused. The host object adds him: he alone hears that it is
 * ready, and his turn runs as his user, in folders named by his username. The host
 * object removes him: he is setting up again, and refused again.
 */

/** The Lab's build ships no resources: its host takes the bundled plugin from the repository. */
const REPOSITORY_ROOT = resolve(import.meta.dirname, '../../..')

const bobUserId = PERSONAS.bob.kind === 'org-member' ? PERSONAS.bob.userId : ''
const danUserId = PERSONAS.dan.kind === 'org-member' ? PERSONAS.dan.userId : ''

interface LabMemberUser { userId: string; username: string; uid: number; home: string; secrets: string }

function promptContext(ctx: ScenarioContext, sessionId: string): IpcContext {
  const session: Partial<SessionCtx> = { sessionId, provider: 'claude-code', agentSessionId: null, status: 'idle', workingDirectory: ctx.cwd, projectPath: ctx.cwd, additionalDirs: [], gitContext: null, worktreeBaseBranch: null, sessionChangedFiles: [], contextWindow: null, permissionMode: 'full-access', preferredModel: null, reasoningEffort: 'medium', fastMode: false, readOnlyReason: null, organizationId: ORGANIZATION_ID }
  const settings: Partial<SettingsCtx> = { activeAgent: 'claude-code', executionPreferences: { rateLimitBehavior: 'queue' } }
  const statusBar: Partial<StatusBarCtx> = { model: 'mock-model', reasoningEffort: 'medium', fastMode: false }
  // SAFETY: the host reads only the fields named here (run-input.ts), as in seats.ts.
  return { session, settings, statusBar } as IpcContext
}

async function prompt(client: LabClient, ctx: ScenarioContext, sessionId: string, text: string) {
  await client.rpc('watchSession', { sessionId })
  return client.rpc('prompt', promptContext(ctx, sessionId), { prompt: text, clientPromptId: `${sessionId}-${Date.now()}` })
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The host object, played by the Lab: the users file it writes, and the member switch the image installs. */
interface HostObject {
  usersDir: string
  usersFile: string
  shared: string
  uid: number
  dan: LabMemberUser
  bob: LabMemberUser
  /** As the script writes it: the whole table and the folders, last, by rename. */
  writeUsers: (users: LabMemberUser[]) => void
  /** Each start the switch made: `<uid> <command>`. */
  switched: () => string[]
}

function playHostObject(): HostObject {
  const usersDir = mkdtempSync(join(tmpdir(), 'solus-lab-member-users-'))
  const usersFile = join(usersDir, 'member-users.json')
  const uid = process.getuid?.() ?? 0
  // The folders the host object's script would make, in the Lab's own temporary folder.
  const memberUserFor = (userId: string, username: string): LabMemberUser => ({ userId, username, uid, home: join(usersDir, 'members', username), secrets: join(usersDir, 'secrets', username) })
  const shared = join(usersDir, 'shared')
  mkdirSync(join(shared, 'files'), { recursive: true })
  // The image's member switch: it keeps the switch's form (`<uid> -- <command> [args]`),
  // records each start, and runs the command as the developer's own user, which macOS cannot change.
  const memberSwitch = join(usersDir, 'solus-switch')
  const switchLog = join(usersDir, 'switch.log')
  writeFileSync(memberSwitch, `#!/bin/sh\n[ "$2" = "--" ] || exit 126\necho "$1 $3" >> ${JSON.stringify(switchLog)}\nshift 2\nexec "$@"\n`, { mode: 0o755 })
  const layout = { switch: memberSwitch, shared, reviews: join(usersDir, 'reviews') }
  return {
    usersDir,
    usersFile,
    shared,
    uid,
    dan: memberUserFor(danUserId, 'dan-lab'),
    bob: memberUserFor(bobUserId, 'bob-lab'),
    writeUsers: (users) => {
      writeFileSync(`${usersFile}.tmp`, JSON.stringify({ layout, users }))
      renameSync(`${usersFile}.tmp`, usersFile)
    },
    switched: () => existsSync(switchLog) ? readFileSync(switchLog, 'utf8').trim().split('\n') : [],
  }
}

interface World {
  ctx: ScenarioContext
  machine: LabHost
  host: HostObject
  bobClient: LabClient
  danClient: LabClient
}

async function preparingStep({ ctx, machine, host, bobClient, danClient }: World): Promise<void> {
  ctx.step('the host put what members read where the users file says')
  ctx.check('the bundled Solus plugin is in the shared folder, not the server\'s data folder', existsSync(join(host.shared, 'plugins', 'solus', '.claude-plugin', 'plugin.json')) && !existsSync(join(machine.dataDir, 'plugins')))

  ctx.step('bob has no user yet: his workspace is being set up, and his turn is refused')
  const bobInfo = await expectOk(ctx, 'bob reads the server info', bobClient.rpc('connectionsGetServerInfo'))
  ctx.check('it says his workspace is preparing', bobInfo?.memberWorkspace === 'preparing', JSON.stringify(bobInfo?.memberWorkspace))
  const danInfo = await expectOk(ctx, 'dan reads the server info', danClient.rpc('connectionsGetServerInfo'))
  ctx.check('dan, who has a user, is not preparing', danInfo?.memberWorkspace === undefined, JSON.stringify(danInfo?.memberWorkspace))
  await expectRefused(ctx, 'bob\'s prompt is refused with WORKSPACE_PREPARING', prompt(bobClient, ctx, 'bob-preparing', 'bob before his user'), 'WORKSPACE_PREPARING')
  await expectRefused(ctx, 'so is pasting a seat token: he has no seat folder yet', bobClient.rpc('seatConnectToken', { provider: 'claude-code', token: 'lab-token-bob' }), 'WORKSPACE_PREPARING')
  ctx.check('nothing ran for bob', !recordedRuns({ host: machine }).some((run) => run.prompt.includes('bob before his user')))
}

async function readyStep({ ctx, host, bobClient, danClient }: World): Promise<void> {
  ctx.step('the host object adds bob: he alone hears that he is ready')
  host.writeUsers([host.dan, host.bob])
  const ready = await expectOk(ctx, 'bob receives connection.memberWorkspaceReady', bobClient.waitForEvent('connection.memberWorkspaceReady', (event) => event.payload.userId === bobUserId))
  ctx.check('the event names bob', ready?.payload.userId === bobUserId)
  await settle(200)
  ctx.check('dan hears nothing of it', danClient.received('connection.memberWorkspaceReady').length === 0)
  const bobReady = await expectOk(ctx, 'bob reads the server info again', bobClient.rpc('connectionsGetServerInfo'))
  ctx.check('he is no longer preparing', bobReady?.memberWorkspace === undefined, JSON.stringify(bobReady?.memberWorkspace))
}

async function runStep({ ctx, machine, bobClient }: World): Promise<void> {
  ctx.step('bob\'s turn runs as his user, in folders named by his username')
  const connected = await expectOk(ctx, 'bob pastes a Claude token', bobClient.rpc('seatConnectToken', { provider: 'claude-code', token: 'lab-token-bob' }))
  ctx.check('his seat is connected', connected?.state === 'connected', JSON.stringify(connected?.state))
  const seatHome = `${machine.dataDir}-seats/claude/bob-lab`
  const tokenMode = statSync(join(seatHome, 'solus-seat-token')).mode & 0o777
  // Written by a process running as bob: group read is added so the server reads it back.
  ctx.check('the token file was written as the member, readable by the server group only', tokenMode === 0o640, tokenMode.toString(8))
}

async function runAsMemberStep({ ctx, machine, host, bobClient }: World): Promise<void> {
  const seatHome = `${machine.dataDir}-seats/claude/bob-lab`
  const started = await expectOk(ctx, 'bob\'s prompt is accepted', prompt(bobClient, ctx, 'bob-ready', 'bob with his user'))
  ctx.check('the prompt started', started?.disposition === 'started', started?.disposition)
  await settle(300)
  const run = recordedRuns({ host: machine }).findLast((candidate) => candidate.prompt.includes('bob with his user'))
  ctx.check('the run reached the provider', !!run)
  ctx.check('it ran in bob\'s seat folder, named by his username', run?.seat?.home === seatHome, run?.seat?.home)
  ctx.check('it runs as the uid the users file gives bob', run?.seat?.launch?.user?.uid === host.uid, JSON.stringify(run?.seat?.launch?.user))
  // Writing his token and his git config went through the member switch, as bob.
  ctx.check('the host started bob\'s processes through the member switch, with his uid', host.switched().some((line) => line.startsWith(`${host.uid} `)), JSON.stringify(host.switched()))
  ctx.check('with the home the users file names', run?.seat?.launch?.env.HOME === host.bob.home, run?.seat?.launch?.env.HOME)
  // Solus's own files in his home were written there, as him: his git config.
  ctx.check('his git config is in that home', existsSync(join(host.bob.home, '.gitconfig')))
}

async function removedStep({ ctx, host, bobClient, danClient }: World): Promise<void> {
  ctx.step('the host object removes bob: he is setting up again, and refused')
  host.writeUsers([host.dan])
  const deadline = Date.now() + 5_000
  let isPreparing = false
  while (!isPreparing && Date.now() < deadline) {
    isPreparing = (await bobClient.rpc('connectionsGetServerInfo')).memberWorkspace === 'preparing'
    if (!isPreparing) await settle(100)
  }
  ctx.check('his server info says preparing again', isPreparing)
  await expectRefused(ctx, 'his next prompt is refused with WORKSPACE_PREPARING', prompt(bobClient, ctx, 'bob-removed', 'bob after removal'), 'WORKSPACE_PREPARING')
  const danStill = await expectOk(ctx, 'dan reads the server info', danClient.rpc('connectionsGetServerInfo'))
  ctx.check('dan is untouched', danStill?.memberWorkspace === undefined)
}

export default scenario('member users: a member waits for their user, then runs as it; removed, they wait again', async (ctx) => {
  const host = playHostObject()
  host.writeUsers([host.dan])
  // Its own host id: the scenario's host must not share the Lab host's delegations with the issuer.
  const machine = await bootLabHost({ flavor: 'managed', issuer: ctx.issuer, hostId: 'labhostmemberusr', environment: { SOLUS_MEMBER_USERS_FILE: host.usersFile, SOLUS_INSTALL_DIR: REPOSITORY_ROOT } })
  const client = (personaId: string) => new LabClient({ persona: personaForHost(personaId, 'managed'), hostUrl: machine.tunnelUrl, issuer: ctx.issuer, hostId: machine.hostId, hostKind: 'managed' })
  const bobClient = client('bob')
  const danClient = client('dan')
  try {
    ctx.check('bob dials the managed host', (await bobClient.connect()).ok)
    ctx.check('dan dials it too', (await danClient.connect()).ok)
    const world: World = { ctx, machine, host, bobClient, danClient }
    await preparingStep(world)
    await readyStep(world)
    await runStep(world)
    await runAsMemberStep(world)
    await removedStep(world)
  } finally {
    bobClient.close()
    danClient.close()
    await machine.stop()
    rmSync(host.usersDir, { recursive: true, force: true })
  }
}, { only: 'managed' })

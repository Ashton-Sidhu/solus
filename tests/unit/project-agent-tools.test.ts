import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { DatabaseSync } from './helpers/bun-sqlite'
import { TEST_HANDLER_CTX } from './helpers/handler-ctx'
import { installTestIdentities } from './helpers/acting-identities'
import type { Principal } from '@solus/server/admission/principal'
import type { AgentTool, AgentToolContext } from '@solus/server/execution/agents/tools/agent-tool'
import { withWorkspaceToolAuthority } from '@solus/server/admission/workspace-tool-authority'

mock.module('node:sqlite', () => ({ DatabaseSync }))
const { SolusServer } = await import('@solus/server/transport/server')
const { registerSetupHandlers } = await import('@solus/server/transport/handlers/setup-handlers')
const { createProjectAgentTool, cloneProjectAgentTool, setProjectToolHost } = await import('@solus/server/execution/agents/tools/project-tools')

const owner = TEST_HANDLER_CTX.principal
const member: Principal = {
  kind: 'org-member', userId: 'user_project_tools', organizationId: 'org-1', organizationRole: 'member',
  teamIds: [], hostKind: 'managed', displayName: 'Member', deviceId: 'test', deviceLabel: 'Test', expiresAt: Date.now() + 60_000,
}
const guest: Principal = {
  kind: 'guest', guestId: 'guest-1', displayName: 'Guest', deviceId: 'guest-1', deviceLabel: 'Test', expiresAt: Date.now() + 60_000,
  share: { resource: { kind: 'session', id: 'session-1' }, role: 'editor', sharedByUserId: 'local', linkSecretHash: 'test' },
}

installTestIdentities()

describe('agent project tools use the admitted project service', () => {
  let root: string
  let registered: string[]
  let cloneCommands: string[][]
  let failClone: boolean
  let cloneSignal: AbortSignal | undefined
  let context: AgentToolContext
  /** Each folder the tools gave the calling session, with the choice for its codebase. */
  let adopted: { sessionId: string; path: string; addToCodebase: boolean }[]
  let failAdopt: boolean

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'solus-project-tools-'))
    registered = []
    cloneCommands = []
    failClone = false
    cloneSignal = undefined
    adopted = []
    failAdopt = false
    context = { provider: 'codex', cwd: root, sessionId: () => 'session-1', abortSignal: new AbortController().signal,
      parentToolUseId: () => undefined, emit: () => {} }
    const server = new SolusServer()
    registerSetupHandlers(server, {
      projectsRoot: () => root,
      registerProject: async (path) => { registered.push(path); return `local:${path}` },
      loadGithubToken: async () => null,
      // The fake transfer writes only in this test's folder and uses no network or credentials.
      spawnProcess: (_command, args, options) => {
        cloneCommands.push(args)
        cloneSignal = options?.signal
        const child = new ChildProcess()
        Object.defineProperty(child, 'stdout', { value: new PassThrough() })
        Object.defineProperty(child, 'stderr', { value: new PassThrough() })
        queueMicrotask(() => {
          if (failClone) child.stderr?.emit('data', Buffer.from('Repository not found\n'))
          else mkdirSync(join(String(options?.cwd), args.at(-1)!, '.git'), { recursive: true })
          child.emit('close', failClone ? 1 : 0, null)
        })
        return child
      },
    })
    setProjectToolHost({
      create: (request, caller) => server.handle('setupCreateProject', [request], caller),
      clone: (request, caller) => server.handle('setupCloneProject', [request], caller),
      // `SessionFolders.adoptCreated` in the host (tests/unit/session-folder-attach.test.ts): a root is added when the session has a codebase.
      adopt: async (sessionId, path, addToCodebase) => {
        if (failAdopt) throw new Error('The session record is locked.')
        adopted.push({ sessionId, path, addToCodebase })
        return { addedToCodebase: addToCodebase }
      },
    })
  })

  afterEach(() => {
    setProjectToolHost(null)
    rmSync(root, { recursive: true, force: true })
  })

  const run = (tool: AgentTool, input: Parameters<AgentTool['execute']>[0], principal = owner) =>
    withWorkspaceToolAuthority(principal, () => tool.execute(input, context))

  test('creation makes a registered Git repository, and the calling session gets the folder', async () => {
    const result = await run(createProjectAgentTool, { name: 'My Website' })
    expect(result.ok).toBe(true)
    const path = join(root, 'My-Website')
    expect(JSON.parse(result.text)).toEqual({ path, projectKey: `local:${path}`, sessionFolder: true, addedToCodebase: true })
    expect(existsSync(join(path, '.git'))).toBe(true)
    expect(registered).toEqual([path])
    // WHY: the agent works in the new folder in the same session (docs/plans/codebases.md decision 11).
    // The working directory of the session does not move.
    expect(adopted).toEqual([{ sessionId: 'session-1', path, addToCodebase: true }])
    expect(context.cwd).toBe(root)
  })

  test('add_to_codebase false gives the session the folder and leaves the codebase', async () => {
    const created = await run(createProjectAgentTool, { name: 'scratch', add_to_codebase: false })
    expect(JSON.parse(created.text)).toMatchObject({ sessionFolder: true, addedToCodebase: false })
    const cloned = await run(cloneProjectAgentTool, { clone_url: 'https://github.com/example/site.git', add_to_codebase: false })
    expect(JSON.parse(cloned.text)).toMatchObject({ sessionFolder: true, addedToCodebase: false })
    expect(adopted).toEqual([
      { sessionId: 'session-1', path: join(root, 'scratch'), addToCodebase: false },
      { sessionId: 'session-1', path: join(root, 'site'), addToCodebase: false },
    ])
    // The option is for Solus: the project service does not get it.
    expect(cloneCommands[0]).not.toContain('add_to_codebase')
  })

  test('a project that the session cannot get is still made, and the result says why', async () => {
    failAdopt = true
    const result = await run(createProjectAgentTool, { name: 'site' })
    expect(result.ok).toBe(true)
    expect(JSON.parse(result.text)).toEqual({
      path: join(root, 'site'), projectKey: `local:${join(root, 'site')}`,
      sessionFolder: false, addedToCodebase: false, sessionFolderError: 'The session record is locked.',
    })
    expect(registered).toEqual([join(root, 'site')])
  })

  test('the descriptions do not send the agent to a new session', () => {
    // WHY: the folder is a folder of this session now. A new session for it is wasted work.
    for (const tool of [createProjectAgentTool, cloneProjectAgentTool]) {
      expect(tool.description).not.toContain('start_sessions')
      expect(tool.description).toContain('folder of this session')
    }
  })

  test('creation keeps existing files and reports the conflict', async () => {
    mkdirSync(join(root, 'site'))
    writeFileSync(join(root, 'site', 'keep.txt'), 'keep')
    const result = await run(createProjectAgentTool, { name: 'site' })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('already exists')
    expect(readFileSync(join(root, 'site', 'keep.txt'), 'utf8')).toBe('keep')
    expect(registered).toEqual([])
  })

  test('a member uses their own projects folder through RPC actor resolution', async () => {
    const result = await run(createProjectAgentTool, { name: 'site' }, member)
    expect(result.ok).toBe(true)
    expect(JSON.parse(result.text).path).toBe(join(root, 'user_project_tools', 'site'))
  })

  test('a shared-session guest cannot create or clone a host project', async () => {
    for (const [tool, input] of [
      [createProjectAgentTool, { name: 'site' }],
      [cloneProjectAgentTool, { clone_url: 'https://github.com/example/site.git' }],
    ] as const) {
      expect((await run(tool, input, guest)).ok).toBe(false)
    }
    expect(registered).toEqual([])
    expect(cloneCommands).toEqual([])
  })

  test('cloning registers in the same call and forwards cancellation to Git', async () => {
    const result = await run(cloneProjectAgentTool, { clone_url: 'https://github.com/example/site.git', name: 'website', protocol: 'https' })
    expect(result.ok).toBe(true)
    expect(JSON.parse(result.text)).toEqual({
      path: join(root, 'website'), projectKey: `local:${join(root, 'website')}`, auth: 'anonymous', sessionFolder: true, addedToCodebase: true,
    })
    expect(registered).toEqual([join(root, 'website')])
    expect(adopted).toEqual([{ sessionId: 'session-1', path: join(root, 'website'), addToCodebase: true }])
    expect(cloneCommands[0]).toContain('https://github.com/example/site.git')
    expect(cloneSignal).toBe(context.abortSignal)
  })

  test('an occupied clone destination is left intact before Git runs', async () => {
    const destination = join(root, 'existing')
    mkdirSync(destination)
    writeFileSync(join(destination, 'keep.txt'), 'keep')
    const result = await run(cloneProjectAgentTool, { clone_url: 'https://github.com/example/site.git', destination })
    expect(result.ok).toBe(false)
    expect(result.text).toContain('not empty')
    expect(readFileSync(join(destination, 'keep.txt'), 'utf8')).toBe('keep')
    expect(cloneCommands).toEqual([])
    expect(registered).toEqual([])
  })

  test('failed transfers and invalid URLs do not register a project', async () => {
    failClone = true
    const failed = await run(cloneProjectAgentTool, { clone_url: 'https://github.com/example/site.git', protocol: 'https' })
    expect(failed.ok).toBe(false)
    expect(failed.text).toContain('Repository not found')
    expect((await run(cloneProjectAgentTool, { clone_url: '--upload-pack=bad' })).ok).toBe(false)
    expect(registered).toEqual([])
  })

  test('tools refuse missing authority, cancelled turns, relative paths, and unlisted credential fields', async () => {
    expect((await createProjectAgentTool.execute({ name: 'site' }, context)).ok).toBe(false)
    expect((await run(createProjectAgentTool, { name: 'site', parent: '../elsewhere' })).ok).toBe(false)
    expect((await run(cloneProjectAgentTool, { clone_url: 'https://github.com/example/site.git', clean: true })).ok).toBe(false)
    expect((await run(cloneProjectAgentTool, { clone_url: 'https://github.com/example/site.git', credential: { accessToken: 'not-a-token' } })).ok).toBe(false)
    const abort = new AbortController()
    abort.abort()
    context.abortSignal = abort.signal
    expect((await run(createProjectAgentTool, { name: 'site' })).ok).toBe(false)
    expect((await run(cloneProjectAgentTool, { clone_url: 'https://github.com/example/site.git' })).ok).toBe(false)
    expect(registered).toEqual([])
    expect(cloneCommands).toEqual([])
  })
})

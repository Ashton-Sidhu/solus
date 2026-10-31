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

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'solus-project-tools-'))
    registered = []
    cloneCommands = []
    failClone = false
    cloneSignal = undefined
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
    })
  })

  afterEach(() => {
    setProjectToolHost(null)
    rmSync(root, { recursive: true, force: true })
  })

  const run = (tool: AgentTool, input: Parameters<AgentTool['execute']>[0], principal = owner) =>
    withWorkspaceToolAuthority(principal, () => tool.execute(input, context))

  test('creation makes a registered Git repository without changing the session folder', async () => {
    const result = await run(createProjectAgentTool, { name: 'My Website' })
    expect(result.ok).toBe(true)
    expect(JSON.parse(result.text)).toEqual({ path: join(root, 'My-Website'), projectKey: `local:${join(root, 'My-Website')}` })
    expect(existsSync(join(root, 'My-Website', '.git'))).toBe(true)
    expect(registered).toEqual([join(root, 'My-Website')])
    expect(context.cwd).toBe(root)
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
    expect(JSON.parse(result.text)).toEqual({ path: join(root, 'website'), projectKey: `local:${join(root, 'website')}`, auth: 'anonymous' })
    expect(registered).toEqual([join(root, 'website')])
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

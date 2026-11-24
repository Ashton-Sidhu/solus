import { describe, expect, test } from 'bun:test'
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'
import type { NormalizedEvent, PermissionMode } from '@solus/contracts/types'
import { PermissionManager, isUnaskedInSessionFolder, sessionPermissionUpdates } from '@solus/server/execution/agents/claude/claude-permissions'
import type { SessionFolderGate } from '@solus/server/execution/agents/session-folder-gate'
import { UI_TO_SDK_PERMISSION_MODE } from '@solus/server/execution/agents/claude/claude-agent'

function bridge() {
  const manager = new PermissionManager()
  const events: NormalizedEvent[] = []
  manager.onPermissionEvent = (_sessionId, event) => events.push(event)
  const canUseTool = manager.createCanUseTool({ current: 'session-1' })
  const ask = (toolName: string, input: Record<string, unknown>, suggestions?: PermissionUpdate[]) =>
    canUseTool(toolName, input, { signal: new AbortController().signal, toolUseID: 'tool-1', requestId: 'request-1', suggestions })
  const request = () => {
    const event = events.at(-1)
    if (event?.type !== 'permission_request') throw new Error('no permission request')
    return event
  }
  return { manager, ask, request }
}

describe('Claude permission bridge', () => {
  test('full access is the SDK bypass mode', () => {
    // WHY: full access must not depend on a Solus callback allowing each call.
    expect(UI_TO_SDK_PERMISSION_MODE['full-access']).toBe('bypassPermissions')
    expect(UI_TO_SDK_PERMISSION_MODE.supervised).toBe('default')
  })

  test('shows every call the SDK asks about, with no rules of its own', async () => {
    const { manager, ask, request } = bridge()

    const result = ask('Bash', { command: 'ls' })

    // WHY: the SDK already applied the mode and the user's settings before it
    // called us. A second, Solus-only allow list is what this change removed.
    expect(request().toolName).toBe('Bash')
    manager.respondToPermission(request().questionId, 'deny')
    expect(await result).toMatchObject({ behavior: 'deny' })
  })

  test('allow for session writes the SDK suggestion to the session, never to settings', async () => {
    const { manager, ask, request } = bridge()
    const suggestion: PermissionUpdate = {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
      behavior: 'allow',
      destination: 'localSettings',
    }

    const result = ask('Bash', { command: 'npm test' }, [suggestion])
    manager.respondToPermission(request().questionId, 'allow-session')

    expect(await result).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'npm test' },
      updatedPermissions: [{ ...suggestion, destination: 'session' }],
    })
  })

  test('Bash with no suggestion offers no session allow', async () => {
    const { ask, request } = bridge()

    void ask('Bash', { command: 'rm -rf build' })

    // WHY: a rule for the bare tool name would allow every command.
    expect(sessionPermissionUpdates('Bash', undefined)).toBeNull()
    expect(request().options.map((option) => option.id)).toEqual(['allow', 'deny'])
  })

  test('a denial with feedback hands the user text to the agent that asked', async () => {
    const { manager, ask, request } = bridge()

    const result = ask('Bash', { command: 'rm -f build/*.obj' })

    // WHY: the deny message is the tool result of the agent that asked — a
    // subagent's call included. Typed as a prompt, the reply would reach the
    // parent and leave this call waiting.
    expect(request().supportsFeedback).toBe(true)
    manager.respondToPermission(request().questionId, 'deny', undefined, '  Run it in a safer manner.  ')
    expect(await result).toEqual({ behavior: 'deny', message: 'Run it in a safer manner.' })
  })

  test('a denial without feedback keeps the plain message', async () => {
    const { manager, ask, request } = bridge()

    const result = ask('Bash', { command: 'ls' })
    manager.respondToPermission(request().questionId, 'deny', undefined, '   ')

    expect(await result).toEqual({ behavior: 'deny', message: 'User denied this action' })
  })

  test('another tool with no suggestion allows that tool for the session', () => {
    expect(sessionPermissionUpdates('mcp__github__create_issue', [])).toEqual([
      { type: 'addRules', rules: [{ toolName: 'mcp__github__create_issue' }], behavior: 'allow', destination: 'session' },
    ])
  })
})

// docs/plans/codebases.md §6: the SDK learns the directories of a query at
// its start. A folder that the session got in the middle of the turn is not
// one of them, so the SDK blocks its paths and asks here.
describe('a call that the SDK blocked on a path', () => {
  interface Gate extends SessionFolderGate {
    /** Each path the bridge gave the attach rule, and each list a person allowed. */
    asked: string[]
    allowed: string[][]
  }

  function gate(mode: PermissionMode, granted: string[], attachable: string[] = []): Gate {
    const asked: string[] = []
    const allowed: string[][] = []
    const holderOf = (folders: string[], path: string) => folders.find((folder) => path === folder || path.startsWith(`${folder}/`)) ?? null
    return {
      asked,
      allowed,
      modeOf: () => mode,
      grantedFolderOf: (_sessionId, path) => holderOf(granted, path),
      attachUnasked: async (_sessionId, path) => { asked.push(path); return holderOf(attachable, path) },
      attachAllowed: (_sessionId, paths) => { allowed.push([...paths]) },
      checkpointTargets: () => [],
    }
  }

  function blockedBridge(folders: Gate) {
    const manager = new PermissionManager()
    manager.folders = folders
    const events: NormalizedEvent[] = []
    manager.onPermissionEvent = (_sessionId, event) => events.push(event)
    const canUseTool = manager.createCanUseTool({ current: 'thread-1' }, false, null, 'session-1')
    const ask = (toolName: string, blockedPath: string | undefined, extra: Partial<Parameters<typeof canUseTool>[2]> = {}) =>
      canUseTool(toolName, { file_path: blockedPath }, { signal: new AbortController().signal, toolUseID: 'tool-1', requestId: 'request-1', blockedPath, ...extra })
    /** Resolves when the bridge showed its next card: a blocked path is first given to the session folders. */
    const card = async () => {
      for (let turn = 0; turn < 5 && events.length === 0; turn++) await Promise.resolve()
      const event = events.shift()
      if (event?.type !== 'permission_request') throw new Error('no permission request')
      return event
    }
    return { manager, events, ask, card }
  }

  const addDirectory = (folder: string) => [{ type: 'addDirectories', directories: [folder], destination: 'session' }]

  test('a path in a granted folder is allowed with no card, and the query learns the folder', async () => {
    const { ask, events } = blockedBridge(gate('supervised', ['/work/libs/ui']))

    expect(await ask('Read', '/work/libs/ui/src/main.ts')).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/work/libs/ui/src/main.ts' },
      updatedPermissions: addDirectory('/work/libs/ui'),
    })
    expect(events).toEqual([])
  })

  test('the mode still decides a change in a granted folder, as it does in the working directory', async () => {
    // WHY: decision 8 says that edits in an attached folder follow the mode. A folder that the
    // session got in the middle of a turn must not let a supervised session edit with no card.
    expect(isUnaskedInSessionFolder('Edit', 'supervised')).toBe(false)
    expect(isUnaskedInSessionFolder('Bash', 'accept-edits')).toBe(false)
    expect(isUnaskedInSessionFolder('Edit', 'plan')).toBe(false)
    expect(isUnaskedInSessionFolder('Edit', 'accept-edits')).toBe(true)
    expect(isUnaskedInSessionFolder('Bash', 'auto')).toBe(true)
    expect(isUnaskedInSessionFolder('Grep', undefined)).toBe(true)

    const supervised = blockedBridge(gate('supervised', ['/work/libs/ui']))
    void supervised.ask('Edit', '/work/libs/ui/src/main.ts')
    expect((await supervised.card()).toolName).toBe('Edit')

    const acceptEdits = blockedBridge(gate('accept-edits', ['/work/libs/ui']))
    expect(await acceptEdits.ask('Edit', '/work/libs/ui/src/main.ts')).toMatchObject({ behavior: 'allow', updatedPermissions: addDirectory('/work/libs/ui') })
    expect(acceptEdits.events).toEqual([])
  })

  test('in auto, a path outside every folder runs the attach rule, then the call is allowed', async () => {
    const folders = gate('auto', [], ['/work/tools/cli'])
    const { ask, events } = blockedBridge(folders)

    expect(await ask('Edit', '/work/tools/cli/src/main.ts')).toMatchObject({ behavior: 'allow', updatedPermissions: addDirectory('/work/tools/cli') })
    expect(folders.asked).toEqual(['/work/tools/cli/src/main.ts'])
    expect(events).toEqual([])
  })

  test('in auto, a path that the rule does not attach gets the normal card', async () => {
    const { ask, card } = blockedBridge(gate('auto', []))
    void ask('Edit', '/srv/other/main.ts')
    expect((await card()).toolName).toBe('Edit')
  })

  test('in a card mode, "Allow for Session" on a path outside the folders also attaches its folder', async () => {
    const folders = gate('supervised', [])
    const { manager, ask, card } = blockedBridge(folders)
    const suggestion: PermissionUpdate = { type: 'addDirectories', directories: ['/work/tools/cli/src'], destination: 'localSettings' }

    const once = ask('Read', '/work/tools/cli/src/main.ts', { suggestions: [suggestion] })
    const first = await card()
    // The rule was not run: in a card mode the person decides on the normal card.
    expect(folders.asked).toEqual([])
    expect(first.options.map((option) => option.id)).toEqual(['allow', 'allow-session', 'deny'])
    manager.respondToPermission(first.questionId, 'allow')
    expect(await once).toMatchObject({ behavior: 'allow' })
    // "Allow Once" is for one call: the folder does not become a session folder.
    expect(folders.allowed).toEqual([])

    const forSession = ask('Read', '/work/tools/cli/src/main.ts', { suggestions: [suggestion] })
    const second = await card()
    manager.respondToPermission(second.questionId, 'allow-session')
    expect(await forSession).toMatchObject({ behavior: 'allow', updatedPermissions: [{ ...suggestion, destination: 'session' }] })
    expect(folders.allowed).toEqual([['/work/tools/cli/src/main.ts']])
  })

  test('a request with no blocked path, and a request that an ask rule of the person forced, are not answered here', async () => {
    const folders = gate('auto', ['/work/libs/ui'], ['/work/tools/cli'])
    const { manager, ask, events } = blockedBridge(folders)

    const plain = ask('Bash', undefined)
    const forced = ask('Read', '/work/libs/ui/src/main.ts', { matchedAskRule: { source: 'userSettings', toolName: 'Read' } })
    // WHY: these requests show their card with no wait, as before the session folders existed.
    expect(events.map((event) => event.type)).toEqual(['permission_request', 'permission_request'])
    expect(folders.asked).toEqual([])
    for (const event of events) if (event.type === 'permission_request') manager.respondToPermission(event.questionId, 'allow-session')
    await Promise.all([plain, forced])
    // Neither request names a path for the session folders.
    expect(folders.allowed).toEqual([])
  })
})

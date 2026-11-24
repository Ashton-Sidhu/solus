import { afterEach, describe, expect, mock, test } from 'bun:test'
import type { RunConfig, Session } from '@solus/contracts/types'
import { folderLocation } from '@solus/workspace-ui/contexts/workspace/run-location'
import { activeStepNote } from '@solus/workspace-ui/components/conversation/lib/status-card'

const toastErrors: string[] = []
mock.module('@solus/workspace-ui/lib/toasts', () => ({
  toasts: { error: (message: string) => toastErrors.push(message), success: () => {}, info: () => {} },
}))
const focusRequests: unknown[] = []
mock.module('@solus/workspace-ui/lib/inputFocus', () => ({
  FOCUS_INPUT_EVENT: 'solus:focus-input',
  requestInputFocus: (target: unknown) => { focusRequests.push(target) },
  blurActiveTextInputOnMobile: () => {},
}))

/**
 * The entry points of the folders of a session (docs/plans/codebases.md §9):
 * the palette offers each one only while it can act, and "Add folder" is the
 * same command from the palette and from the project panel.
 */

interface PickerRequest { tabId: string; intent: string; folderChoice: { title: string; action: string; onChosen(path: string, serverId: string): void } }

const previousWindow = (globalThis as { window?: unknown }).window
afterEach(() => {
  toastErrors.length = 0
  focusRequests.length = 0
  ;(globalThis as { window?: unknown }).window = previousWindow
})

function workspaceWith(options: { started: boolean; codebaseId: string | null; folderCount: number }) {
  const run = { location: folderLocation({ serverId: 'host', path: '/code/shop/web' }, { codebaseId: options.codebaseId }) } as RunConfig
  const session = {
    id: 'session-1',
    agentSessionId: options.started ? 'thread-1' : null,
    messages: [],
    status: 'idle',
    sessionFolders: Array.from({ length: options.folderCount }, (_unused, index) => ({ path: `/code/f${index}` })),
    run,
  } as unknown as Session
  const navigations: unknown[] = []
  const layout: [string, unknown][] = []
  const personal: [string, unknown][] = []
  const attached: [string, string][] = []
  const settings = {
    projectPanelHiddenItems: ['repositories', 'git.branch'] as string[],
    projectPanelCollapsed: { repositories: true },
    splitProjectPanelCollapsed: { repositories: true },
    setPersonal: (key: string, value: unknown) => { personal.push([key, value]); return true },
    setLayout: (key: string, value: unknown) => { layout.push([key, value]) },
  }
  const workspace = {
    focusedSourceId: 'tab-1',
    activeTabId: 'tab-1',
    chatSurfaceTabId: null,
    sessionFor: () => session,
    runFor: () => run,
    apiFor: () => ({
      sessionAttachFolder: async (sessionId: string, path: string) => {
        attached.push([sessionId, path])
        if (path === '/refused') throw new Error('You cannot use this folder.')
        return [{ path, name: 'tools', state: 'git', repositoryPath: path, source: 'attached', granted: true }]
      },
    }),
    settings,
    router: { navigate: (ref: unknown) => { navigations.push(ref) } },
  }
  return { workspace, session, navigations, layout, personal, attached }
}

async function commandsFor(options: Parameters<typeof workspaceWith>[0]) {
  const { repositoryCommands } = await import('@solus/workspace-ui/components/project-panel/lib/repository-commands')
  const built = workspaceWith(options)
  return { ...built, commands: repositoryCommands(built.workspace as never) }
}

describe('the palette entries of a session', () => {
  // A session that has not started has no folders on its host yet.
  test('a session that has not started offers only the page of its codebase', async () => {
    const { commands } = await commandsFor({ started: false, codebaseId: 'shop', folderCount: 0 })
    expect(commands.map((command) => command.label)).toEqual(['Open codebase settings'])
  })

  test('a started session with one working directory and no codebase offers Add folder only', async () => {
    const { commands } = await commandsFor({ started: true, codebaseId: null, folderCount: 0 })
    expect(commands.map((command) => command.label)).toEqual(['Add folder to this session'])
  })

  test('a started session of a codebase offers each entry', async () => {
    const { commands } = await commandsFor({ started: true, codebaseId: 'shop', folderCount: 2 })
    expect(commands.map((command) => command.label)).toEqual(['Add folder to this session', 'Show repositories', 'Open codebase settings'])
  })

  test('"Open codebase settings" opens the page of the codebase of the session', async () => {
    const { commands, navigations } = await commandsFor({ started: true, codebaseId: 'shop', folderCount: 0 })
    void commands.find((command) => command.id === 'open-session-codebase')!.run?.()
    expect(navigations).toEqual([{ name: 'settings', params: { tab: 'codebases', codebase: 'shop' } }])
  })

  // The person asked to see the section: a section that they hid, in a closed
  // panel, must show. Their other hidden rows stay hidden.
  test('"Show repositories" opens the panel and the section, and shows a section that was hidden', async () => {
    const { commands, layout, personal, workspace } = await commandsFor({ started: true, codebaseId: 'shop', folderCount: 1 })
    void commands.find((command) => command.id === 'show-repositories')!.run?.()
    expect(personal).toEqual([['projectPanelHiddenItems', ['git.branch']]])
    expect(layout).toContainEqual(['projectPanelOpen', true])
    expect(workspace.settings.projectPanelCollapsed.repositories).toBe(false)
    expect(workspace.settings.splitProjectPanelCollapsed.repositories).toBe(true)
  })
})

describe('"Add folder"', () => {
  function pickerRequests(): PickerRequest[] {
    const requests: PickerRequest[] = []
    ;(globalThis as { window?: unknown }).window = {
      dispatchEvent: (event: CustomEvent<PickerRequest>) => { requests.push(event.detail); return true },
    }
    return requests
  }

  test('asks for a folder on the run host of the tab, then attaches it to the session', async () => {
    const { addSessionFolder } = await import('@solus/workspace-ui/components/project-panel/lib/repository-actions')
    const { workspace, session, attached } = workspaceWith({ started: true, codebaseId: null, folderCount: 0 })
    const requests = pickerRequests()
    addSessionFolder(workspace as never, 'tab-1')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ tabId: 'tab-1', intent: 'choose-folder', folderChoice: { action: 'Add folder' } })

    requests[0]!.folderChoice.onChosen('/code/tools', 'host')
    await Bun.sleep(0)
    expect(attached).toEqual([['session-1', '/code/tools']])
    // The answer of the host is the list of the tab now, and focus goes back to the prompt.
    expect(session.sessionFolders.map((folder) => folder.path)).toEqual(['/code/tools'])
    expect(focusRequests).toEqual([{ tabId: 'tab-1' }])
  })

  test('a refusal of the host is said to the person, and the list stays', async () => {
    const { addSessionFolder } = await import('@solus/workspace-ui/components/project-panel/lib/repository-actions')
    const { workspace, session } = workspaceWith({ started: true, codebaseId: null, folderCount: 0 })
    const requests = pickerRequests()
    addSessionFolder(workspace as never, 'tab-1')
    requests[0]!.folderChoice.onChosen('/refused', 'host')
    await Bun.sleep(0)
    expect(toastErrors).toEqual(["Couldn't add the folder"])
    expect(session.sessionFolders).toEqual([])
  })
})

// The checkout step of a task folder names the repository it is on, so the
// person sees that a long setup moves: "web (2 of 3)".
describe('a running step of the setup card', () => {
  test('shows the detail of the host, then its percentage', () => {
    expect(activeStepNote({ detail: 'web (2 of 3)' })).toBe('web (2 of 3)')
    expect(activeStepNote({ detail: 'web (2 of 3)', percent: 40 })).toBe('web (2 of 3) · 40%')
  })

  test('a step with no detail keeps its percentage or "running"', () => {
    expect(activeStepNote({ percent: 40 })).toBe('40%')
    expect(activeStepNote({})).toBe('running')
  })
})

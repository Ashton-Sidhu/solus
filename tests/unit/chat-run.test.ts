import { describe, expect, test } from 'bun:test'
import type { RunConfig } from '@solus/contracts/types'
import { NEW_CHAT_DIRECTORY } from '@solus/contracts/chat'
import { CHAT_LABEL, displayDirName, projectDirLabel } from '@solus/workspace-ui/lib/paths'
import { defaultStartProject, inheritRunConfig, resolveNewRunConfig } from '@solus/workspace-ui/contexts/workspace/run-config'

// A chat (docs/plans/projectless-chat.md) is a session with no project. Its
// folder is its own, so it never leaks into the next session, and every client
// names it "Chat" from the path alone, before any host answers.

const CHAT = '/data/projects/ada-1/.solus-chats/session-1'

function run(workingDirectory: string, overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    workingDirectory,
    gitContext: null,
    worktree: null,
    modelConfig: { modelId: null, reasoningEffort: 'high', contextWindow: null, fastMode: false },
    permissionMode: 'full-access',
    provider: null,
    serverId: 'studio',
    taskServerId: 'studio',
    projectGroupPath: null,
    sessionSkills: [],
    pendingHostDispatch: null,
    ...overrides,
  }
}

describe('the chat label', () => {
  test('a chat reads "Chat" on any host, with nothing asked of the host', () => {
    // WHY: the label used to wait for the host to name its chat folder, and a row
    // showed ".chat" until then.
    expect(projectDirLabel(CHAT)).toBe(CHAT_LABEL)
    expect(projectDirLabel(NEW_CHAT_DIRECTORY)).toBe(CHAT_LABEL)
    expect(displayDirName(CHAT)).toBe(CHAT_LABEL)
  })

  test('a project keeps its own name, and the home folder stays ~', () => {
    expect(projectDirLabel('/data/projects/ada-1/web')).toBe('web')
    expect(projectDirLabel('~')).toBe('~')
  })
})

describe('a session opened from a chat', () => {
  const defaults = run('/Users/me/projects/solus', { serverId: 'local', taskServerId: 'local' })

  test('starts a new chat on the same host, never in the old chat folder', () => {
    // WHY: one folder per chat. Sharing it would mix the files of two chats.
    const fresh = resolveNewRunConfig(defaults, run(CHAT), { freshTask: true })
    expect(fresh.workingDirectory).toBe(NEW_CHAT_DIRECTORY)
    expect(fresh.serverId).toBe('studio')
    expect(inheritRunConfig(defaults, run(CHAT)).workingDirectory).toBe(NEW_CHAT_DIRECTORY)
  })

  test('a session opened from a project stays in that project', () => {
    expect(resolveNewRunConfig(defaults, run('/data/projects/ada-1/web'), { freshTask: true }).workingDirectory)
      .toBe('/data/projects/ada-1/web')
  })
})

describe('where a new session starts', () => {
  const newChat = { serverId: 'local', directory: NEW_CHAT_DIRECTORY }

  test('in the last project while its host is up, else in a new chat', () => {
    const last = { serverId: 'studio', directory: '/Users/me/projects/solus' }
    expect(defaultStartProject(last, () => false, newChat)).toEqual(last)
    expect(defaultStartProject(last, () => true, newChat)).toEqual(newChat)
    expect(defaultStartProject(null, () => false, newChat)).toEqual(newChat)
  })
})

import { describe, expect, test } from 'bun:test'
import type { IpcContext, RunConfig } from '@solus/contracts/types'
import { draftPluginCommandIdentity, draftPluginCommandScope } from '@solus/workspace-ui/components/session-draft/lib/plugin-command-scope'
import { adoptGit, folderLocation, openFolder } from '@solus/workspace-ui/contexts/workspace/run-location'

function run(provider: RunConfig['provider'], modelId: string): RunConfig {
  return {
    provider,
    location: folderLocation({ serverId: 'local', path: '/repo' }),
    modelConfig: {
      modelId,
      reasoningEffort: 'high',
      contextWindow: null,
      fastMode: false,
    },
  } as RunConfig
}

function context(): IpcContext {
  return {
    session: {
      provider: null,
      preferredModel: null,
    },
  } as IpcContext
}

describe('draft plugin command scope', () => {
  test('uses the provider and model selected in the draft picker', () => {
    // WHY: a draft has no session cache. Command discovery must follow its own
    // picker instead of the active tab, or Claude skills remain under Codex.
    const claude = draftPluginCommandScope(
      run('claude-code', 'claude-opus-4-1'),
      'codex',
      'draft-1',
      context,
    )
    const codex = draftPluginCommandScope(
      run('codex', 'gpt-5.6-codex'),
      'claude-code',
      'draft-1',
      context,
    )

    expect(claude.context.session).toMatchObject({
      provider: 'claude-code',
      preferredModel: 'claude-opus-4-1',
    })
    expect(codex.context.session).toMatchObject({
      provider: 'codex',
      preferredModel: 'gpt-5.6-codex',
    })
  })

  test('uses the app provider only when the draft has no explicit provider', () => {
    // WHY: restored legacy drafts can omit their provider, but they must still
    // resolve commands deterministically before the first prompt starts.
    const scope = draftPluginCommandScope(
      run(null, 'gpt-5.6-codex'),
      'codex',
      'draft-1',
      context,
    )

    expect(scope.provider).toBe('codex')
    expect(scope.context.session.provider).toBe('codex')
  })

  test('reads again for a new place or pick, never for a Git answer', () => {
    // WHY: the composer reads commands once per identity. A Git answer replaces
    // the draft's location; if it changed the identity, every answer would send
    // another getPluginCommands and a folder outside Git would never settle.
    const draft = run('claude-code', 'claude-opus-4-1')
    const identity = draftPluginCommandIdentity(draft, 'codex')
    const answered = { ...draft, location: adoptGit(draft.location, { serverId: 'local', path: '/repo' }, null, null) }
    expect(draftPluginCommandIdentity(answered, 'codex')).toBe(identity)
    const onMain = { ...draft, location: adoptGit(draft.location, { serverId: 'local', path: '/repo' }, { repoRoot: '/repo', branch: 'main', targetBranch: 'main' }) }
    expect(draftPluginCommandIdentity(onMain, 'codex')).toBe(identity)

    expect(draftPluginCommandIdentity(run('claude-code', 'claude-sonnet-4-5'), 'codex')).not.toBe(identity)
    expect(draftPluginCommandIdentity(run('codex', 'claude-opus-4-1'), 'codex')).not.toBe(identity)
    const moved = { ...draft, location: openFolder(draft.location, { serverId: 'remote', path: '/repo' }) }
    expect(draftPluginCommandIdentity(moved, 'codex')).not.toBe(identity)
  })
})

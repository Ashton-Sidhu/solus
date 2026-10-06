import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { makeSession, makeTab } from '@solus/workspace-ui/contexts/workspace/session.factories'

/**
 * A task's lead is composed with its task page beside the draft. Send turns the
 * draft into a session; the page the user wrote the prompt against must stay.
 */

const file = new URL('../../packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts', import.meta.url)
const parsed = ts.createSourceFile('workspace.context.svelte.ts', readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
const owner = parsed.statements.find((statement): statement is ts.ClassDeclaration =>
  ts.isClassDeclaration(statement) && statement.name?.getText(parsed) === 'WorkspaceContext')!
const createSessionCode = owner.members
  .filter((member) => member.name?.getText(parsed) === 'createSession')
  .map((member) => member.getText(parsed)).join('\n')
const { Workspace } = new Function('makeSession', 'makeTab', 'uuid', 'track', 'startsWorktree', 'requestInputFocus',
  new Bun.Transpiler({ loader: 'ts' }).transformSync(`class Workspace { ${createSessionCode} }\nreturn { Workspace }`),
)(makeSession, makeTab, crypto.randomUUID.bind(crypto), () => {}, () => false, () => {})

function workspace() {
  const resets: Array<{ closeArtifact?: boolean; keepAside?: boolean }> = []
  // SAFETY: the fixture supplies every workspace field createSession reads.
  const context: any = Object.assign(new Workspace(), {
    settings: { rateLimitBehavior: 'ask' },
    pluginCommands: { global: [], project: [] },
    sessions: { byId: {} },
    tabs: {},
    addTabToOrder: () => {},
    rememberLastProject: () => {},
    setActiveTab: () => {},
    resetOverlays: (opts: { closeArtifact?: boolean; keepAside?: boolean }) => { resets.push(opts) },
    config: { refreshSessionStartTarget: async () => {} },
    lifecycle: { refreshPluginCommands: async () => {} },
  })
  return { context, resets }
}

const spec = { run: { workingDirectory: '/code/solus', gitContext: null }, task: { kind: 'existing', taskId: 't1', role: 'lead' } }

describe('sending a lead draft', () => {
  test('keeps the task page beside it', () => {
    const { context, resets } = workspace()
    context.createSession(spec, { via: 'click', keepAside: true })
    // WHY: the page was opened beside the draft so the task stays on screen
    // while its lead works; Send closing it hides the record the prompt is about.
    expect(resets).toEqual([{ closeArtifact: true, keepAside: true }])
  })

  test('a plain new session still clears the pages around it', () => {
    const { context, resets } = workspace()
    context.createSession(spec, { via: 'click' })
    expect(resets).toEqual([{ closeArtifact: true, keepAside: undefined }])
  })
})

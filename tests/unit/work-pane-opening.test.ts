import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('../../packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts', import.meta.url), 'utf8')
const ast = ts.createSourceFile('workspace.ts', source, ts.ScriptTarget.Latest, true)
let method = ''
function visit(node: ts.Node): void {
  if (ts.isMethodDeclaration(node) && node.name.getText(ast) === 'openWorkModal') method = node.getText(ast)
  ts.forEachChild(node, visit)
}
visit(ast)
if (!method) throw new Error('Missing openWorkModal command')
const transpiler = new Bun.Transpiler({ loader: 'ts' })
const command = new Function('track', `${transpiler.transformSync(`class Workspace { ${method} }`)}; return Workspace.prototype.openWorkModal`)(() => {})

test('a known work opens beside the conversation before its content read completes', async () => {
  let finish!: (value: null) => void
  const pending = new Promise<null>((resolve) => { finish = resolve })
  const calls: string[] = []
  const workspace = {
    activeTabId: 'tab',
    sessionFor: () => ({ run: { workingDirectory: '/project' } }),
    worksStore: {
      ensureContent(workId: string, source: string, cwd: string) {
        expect([workId, source, cwd]).toEqual(['work', 'open-work-modal', '/project'])
        calls.push('read')
        return pending
      },
    },
    router: { close: () => calls.push('close gallery') },
    openWork: (workId: string, target: string) => calls.push(`${workId}:${target}`),
  }
  const opening = command.call(workspace, 'work', undefined, { secondary: true })
  expect(calls).toEqual(['read', 'close gallery', 'work:aside'])
  // A failed read is handled by the mounted pane, where retry is available.
  finish(null)
  await opening
})

test('a historical title resolves its id before opening, without waiting for the body', async () => {
  let finishManifest!: () => void
  const manifest = new Promise<void>((resolve) => { finishManifest = resolve })
  const opened: string[] = []
  const workspace = {
    activeTabId: 'tab',
    sessionFor: () => ({ run: { workingDirectory: '/project' } }),
    worksStore: {
      works: { work: { title: 'Design' } },
      loadAll: () => manifest,
      ensureContent: () => new Promise(() => {}),
    },
    router: { close: () => {} },
    openWork: (workId: string) => opened.push(workId),
  }
  const opening = command.call(workspace, '', 'Design')
  expect(opened).toEqual([])
  finishManifest()
  await Promise.resolve()
  expect(opened).toEqual(['work'])
  await opening
})

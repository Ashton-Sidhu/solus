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

/** A store that records every body read. Opening must leave the read to the
 *  pane's open-work lease, which subscribes first. */
function storeThatCountsReads(reads: string[], works = {}) {
  return {
    works,
    ensureContent: (workId: string) => { reads.push(workId); return new Promise(() => {}) },
    loadWork: (workId: string) => { reads.push(workId); return new Promise(() => {}) },
  }
}

test('a known work opens beside the conversation without reading its body', async () => {
  // WHY: the pane's lease subscribes to works.changed and then reads. A second
  // read started here would load the body twice on every open.
  const calls: string[] = []
  const reads: string[] = []
  const workspace = {
    activeTabId: 'tab',
    sessionFor: () => ({ run: { workingDirectory: '/project' } }),
    worksStore: storeThatCountsReads(reads),
    router: { close: () => calls.push('close gallery') },
    openWork: (workId: string, target: string) => calls.push(`${workId}:${target}`),
  }
  await command.call(workspace, 'work', undefined, { secondary: true })
  expect(calls).toEqual(['close gallery', 'work:aside'])
  expect(reads).toEqual([])
})

test('a historical title resolves its id from the listing, then opens without reading the body', async () => {
  let finishManifest!: () => void
  const manifest = new Promise<void>((resolve) => { finishManifest = resolve })
  const opened: string[] = []
  const reads: string[] = []
  const workspace = {
    activeTabId: 'tab',
    sessionFor: () => ({ run: { workingDirectory: '/project' } }),
    worksStore: { ...storeThatCountsReads(reads, { work: { title: 'Design' } }), loadAll: () => manifest },
    router: { close: () => {} },
    openWork: (workId: string) => opened.push(workId),
  }
  const opening = command.call(workspace, '', 'Design')
  expect(opened).toEqual([])
  finishManifest()
  await opening
  expect(opened).toEqual(['work'])
  expect(reads).toEqual([])
})

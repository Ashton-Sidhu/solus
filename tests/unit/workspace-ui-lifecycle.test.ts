import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile, compileModule } from 'svelte/compiler'
import ts from 'typescript'

const directory = mkdtempSync(join(tmpdir(), 'solus-ui-lifecycle-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const root = new URL('../../', import.meta.url)
const internal = new URL('node_modules/svelte/src/internal/client/index.js', root).href
const client = new URL('node_modules/svelte/src/index-client.js', root).href
const transpiler = new Bun.Transpiler({ loader: 'ts' })

function executable(code: string): string {
  return code.replaceAll(/(['"])svelte\/internal\/client\1/g, JSON.stringify(internal))
    .replaceAll(/(['"])svelte\1/g, JSON.stringify(client))
    .replaceAll(/import ['"]svelte\/internal\/disclose-version['"];?/g, '')
}

async function run(name: string, code: string) {
  const path = join(directory, `${name}.mjs`)
  writeFileSync(path, code)
  // Each renderer has its own DOM and Svelte runtime; globals never leak into other tests.
  const process = Bun.spawn([processExecPath, path], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ])
  expect({ exitCode, stderr, stdout }).toEqual({ exitCode: 0, stderr: '', stdout: '' })
}
const processExecPath = process.execPath

test('same-number PRs load once for each host and project scope', async () => {
  const source = readFileSync(new URL('packages/workspace-ui/src/components/project-panel/GitSection.svelte', root), 'utf8')
  const script = source.slice(source.indexOf('>') + 1, source.indexOf('</script>'))
  const ast = ts.createSourceFile('GitSection.ts', script, ts.ScriptTarget.Latest, true)
  const index = ast.statements.findIndex((statement) => ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some((declaration) => declaration.name.getText(ast) === 'requestedChecksFor'))
  if (index < 0) throw new Error('Missing checks request lifecycle')
  // Execute the production guard and effect, with a recording host boundary.
  const effect = ast.statements.slice(index, index + 2).map((statement) => statement.getText(ast)).join('\n')
  const harness = `
    import assert from 'node:assert/strict';
    import { flushSync } from 'svelte';
    import { projectScopeOf } from ${JSON.stringify(new URL('packages/contracts/src/types.ts', root).href)};
    let activePr = $state({ number: 7 });
    let prServerId = $state('first-host');
    let env = $state({ cwd: '/first-project', checkout: null });
    const sourceId = 'mounted-tab';
    const prApi = {};
    const calls = [];
    const session = { ctxForEnvironment(cwd) { return { session: { projectPath: cwd, workingDirectory: cwd } } } };
    const pullRequests = { checks: { async load(api, serverId, ctx, numbers) {
      calls.push([serverId, projectScopeOf(ctx.session), numbers[0]]);
    } } };
    const destroy = $effect.root(() => { ${effect} });
    flushSync();
    activePr = { number: 7 }; flushSync();
    assert.equal(calls.length, 1);
    env.cwd = '/second-project'; flushSync();
    prServerId = 'second-host'; flushSync();
    activePr = { number: 8 }; flushSync();
    activePr = null; flushSync();
    assert.deepEqual(calls, [
      ['first-host', '/first-project', 7], ['first-host', '/second-project', 7],
      ['second-host', '/second-project', 7], ['second-host', '/second-project', 8]
    ]);
    destroy();
  `
  await run('checks', executable(compileModule(transpiler.transformSync(harness), { filename: 'checks.svelte.js', generate: 'client' }).js.code))
})

test('diff annotation updates preserve reply roots across other threads and file recycling', async () => {
  // The leaf editor fixture owns local state, like DiffThreadComment. The production
  // controller and Svelte mount/unmount run unchanged; no host or editor services load.
  const fixture = compile(`<script>
    let { thread, collapsed, onSetCollapsed } = $props();
    let reply = $state('');
  </script>
  <textarea aria-label="Reply" bind:value={reply}></textarea>
  <button onclick={() => onSetCollapsed(thread.id, !collapsed)}>Toggle</button>
  <span>{thread.id}:{collapsed}</span>`, { filename: 'editor.svelte', generate: 'client' }).js.code
  const fixturePath = join(directory, 'editor.mjs')
  writeFileSync(fixturePath, executable(fixture))
  const controllerSource = readFileSync(new URL('packages/workspace-ui/src/components/diff/lib/diff-annotations.svelte.ts', root), 'utf8')
  const controller = executable(compileModule(transpiler.transformSync(controllerSource), {
    filename: 'diff-annotations.svelte.js', generate: 'client',
  }).js.code).replaceAll(/(['"])\.\.\/Diff(?:Inline|Thread)Comment\.svelte\1/g, JSON.stringify(fixturePath))
  const controllerPath = join(directory, 'annotations.mjs')
  writeFileSync(controllerPath, controller)
  const jsdomPath = new URL('node_modules/jsdom/lib/api.js', root).href
  await run('annotations-test', `
    import assert from 'node:assert/strict';
    import { JSDOM } from ${JSON.stringify(jsdomPath)};
    const dom = new JSDOM('<!doctype html><body></body>');
    for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Text', 'Comment', 'Event', 'CustomEvent']) {
      globalThis[key] = dom.window[key];
    }
    const { flushSync } = await import(${JSON.stringify(client)});
    const { DiffAnnotations } = await import(${JSON.stringify(controllerPath)});
    const threads = [
      { id: 'A', filePath: 'a.ts', line: 1, side: 'RIGHT', isResolved: false, comments: [] },
      { id: 'B', filePath: 'b.ts', line: 2, side: 'RIGHT', isResolved: true, comments: [] }
    ];
    const files = new Map(['a.ts', 'b.ts', 'empty.ts'].map(id => [id, { id, type: 'diff', annotations: [] }]));
    const updates = [];
    const view = { getItem: id => files.get(id), updateItem(item) { updates.push(item.id); } };
    let layoutChanges = 0;
    const annotations = new DiffAnnotations(new Map(), () => ({}), () => layoutChanges++);
    const draft = { filePath: null, range: null, editingCommentId: null };
    const sync = () => annotations.sync(view, [...files.keys()], [], threads, draft);
    await sync();
    assert.deepEqual(updates, ['a.ts', 'b.ts']);
    const metadata = id => files.get(id).annotations[0].metadata;
    const a = annotations.render(metadata('a.ts'));
    const b = annotations.render(metadata('b.ts'));
    document.body.append(a, b); flushSync();
    const input = a.querySelector('textarea');
    input.value = 'Keep this unsent reply';
    input.dispatchEvent(new Event('input', { bubbles: true })); flushSync();
    updates.length = 0;
    b.querySelector('button').click(); flushSync();
    assert.equal(layoutChanges, 1);
    await sync(); flushSync();
    assert.deepEqual(updates, ['b.ts']);
    assert.equal(annotations.render(metadata('a.ts')), a);
    assert.equal(input.value, 'Keep this unsent reply');
    assert.equal(b.querySelector('span').textContent, 'B:false');
    // A library recycle may remove the target; requesting it again must retain state.
    a.remove();
    document.body.append(annotations.render(metadata('a.ts'))); flushSync();
    assert.equal(a.querySelector('textarea'), input);
    assert.equal(input.value, 'Keep this unsent reply');
    updates.length = 0;
    await sync(); assert.deepEqual(updates, []);
    // A draft affects its own file and then removes the old annotation on cancel.
    draft.filePath = 'empty.ts';
    draft.range = { startLine: 1, endLine: 3, side: 'old' };
    await sync();
    assert.deepEqual(updates, ['empty.ts']);
    assert.equal(files.get('empty.ts').annotations[0].side, 'deletions');
    draft.filePath = null; draft.range = null; updates.length = 0;
    await sync();
    assert.deepEqual(updates, ['empty.ts']);
    assert.equal(files.get('empty.ts').annotations.length, 0);
    // Updating a second thread in A's file must also retain A's local state.
    threads[1] = { ...threads[1], filePath: 'a.ts' };
    await sync(); updates.length = 0;
    b.querySelector('button').click(); flushSync();
    await sync();
    assert.deepEqual(updates, ['a.ts']);
    assert.equal(annotations.render(metadata('a.ts')), a);
    assert.equal(a.querySelector('textarea'), input);
    assert.equal(input.value, 'Keep this unsent reply');
    // A structural refresh restores annotations but keeps reply components.
    annotations.resetFiles();
    await sync();
    assert.equal(annotations.render(metadata('a.ts')), a);
    assert.equal(input.value, 'Keep this unsent reply');
    // Removed threads and the whole stream release their roots.
    threads.splice(0, 1);
    await sync(); flushSync();
    assert.equal(a.querySelector('textarea'), null);
    const pending = sync();
    const updatesBeforeDestroy = updates.length;
    annotations.destroy(); await pending; flushSync();
    assert.equal(updates.length, updatesBeforeDestroy);
    assert.equal(b.querySelector('textarea'), null);
    dom.window.close();
  `)
})

test('revealing a conversation clears unread across its tabs without selecting it again', async () => {
  const source = readFileSync(new URL('packages/workspace-ui/src/contexts/workspace/workspace.context.svelte.ts', root), 'utf8')
  const ast = ts.createSourceFile('workspace.ts', source, ts.ScriptTarget.Latest, true)
  const workspace = ast.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'WorkspaceContext')!
  const selected = ['trackVisibleConversations', 'isSessionVisible', 'showsConversation']
  const methods = workspace.members.filter((node) => node.name && selected.includes(node.name.getText(ast)))
  expect(methods).toHaveLength(selected.length)
  const harness = `
    import assert from 'node:assert/strict';
    import { flushSync } from 'svelte';
    const visibleRef = pane => pane.overlay ?? pane.base;
    class Workspace {
      shell = $state({ visible: false, conversationVisible: true, hasCompanionPanes: false });
      tabs = $state({ first: { sessionId: 'one', hasUnread: true }, duplicate: { sessionId: 'one', hasUnread: true }, second: { sessionId: 'two', hasUnread: true } });
      tabOrder = $state(['first', 'duplicate', 'second']);
      activeTabId = $state('first');
      router = $state({ leadingPane: { base: { name: 'chat' }, overlay: null }, asidePanes: [], chatSessionIn(id) { return id; } });
      ${methods.map(node => node.getText(ast)).join('\n')}
    }
    const workspace = new Workspace();
    const destroy = $effect.root(() => workspace.trackVisibleConversations());
    flushSync();
    assert.equal(workspace.tabs.first.hasUnread, true);
    workspace.shell.visible = true; flushSync();
    assert.equal(workspace.tabs.first.hasUnread, false);
    assert.equal(workspace.tabs.duplicate.hasUnread, false);
    assert.equal(workspace.tabs.second.hasUnread, true);
    workspace.router.leadingPane.overlay = { name: 'tasks' };
    workspace.tabs.first.hasUnread = true; flushSync();
    assert.equal(workspace.tabs.first.hasUnread, true);
    workspace.router.leadingPane.overlay = null; flushSync();
    assert.equal(workspace.tabs.first.hasUnread, false);
    workspace.shell.conversationVisible = false;
    workspace.tabs.first.hasUnread = true; flushSync();
    assert.equal(workspace.tabs.first.hasUnread, true);
    workspace.shell.conversationVisible = true; flushSync();
    assert.equal(workspace.tabs.first.hasUnread, false);
    workspace.router.asidePanes.push({ id: 'two' }); flushSync();
    assert.equal(workspace.tabs.second.hasUnread, true);
    workspace.shell.hasCompanionPanes = true; flushSync();
    assert.equal(workspace.tabs.second.hasUnread, false);
    destroy();
  `
  await run('unread-visibility', executable(compileModule(transpiler.transformSync(harness), { filename: 'unread.svelte.js', generate: 'client' }).js.code))
})

test('artifact readiness resets for new content and explicit reloads', async () => {
  const source = readFileSync(new URL('packages/workspace-ui/src/components/artifact/SandboxFrame.svelte', root), 'utf8')
  const script = source.slice(source.indexOf('>') + 1, source.indexOf('</script>'))
  const ast = ts.createSourceFile('SandboxFrame.ts', script, ts.ScriptTarget.Latest, true)
  const readiness = ast.statements.filter((statement) => ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some((declaration) => ['frameResult', 'frameSettled'].includes(declaration.name.getText(ast))))
    .map((statement) => statement.getText(ast)).join('\n')
  if (!readiness) throw new Error('Missing artifact readiness state')
  const harness = `
    import assert from 'node:assert/strict';
    let srcdoc = $state('first document');
    let reloadKey = $state(0);
    ${readiness}
    assert.equal(frameSettled, false);
    frameResult = { srcdoc, reloadKey, failed: false };
    assert.equal(frameSettled, true);
    srcdoc = 'second document';
    assert.equal(frameSettled, false);
    frameResult = { srcdoc, reloadKey, failed: false };
    assert.equal(frameSettled, true);
    reloadKey += 1;
    assert.equal(frameSettled, false);
    frameResult = { srcdoc, reloadKey, failed: true };
    assert.equal(frameSettled, true, 'failure ends loading so the error can be shown');
  `
  await run('artifact-readiness', executable(compileModule(transpiler.transformSync(harness), {
    filename: 'artifact-readiness.svelte.js', generate: 'client',
  }).js.code))
})

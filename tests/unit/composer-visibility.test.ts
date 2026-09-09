import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileModule } from 'svelte/compiler'
import ts from 'typescript'

test('only the active mounted composer consumes drafts and focus requests', async () => {
  const root = new URL('../../', import.meta.url)
  const file = new URL('packages/workspace-ui/src/components/input/lib/composer-focus.svelte.ts', root)
  const source = readFileSync(file, 'utf8')
  const ast = ts.createSourceFile('composer-focus.ts', source, ts.ScriptTarget.Latest, true)
  // Run the production lifecycle with recording client boundaries. Each child
  // process owns its Svelte runtime and cannot change another test's globals.
  const production = ast.statements.filter(statement => !ts.isImportDeclaration(statement))
    .map(statement => statement.getText(ast)).join('\n')
  const harness = `
    import assert from 'node:assert/strict';
    import { untrack, flushSync } from 'svelte';
    let shown = $state('first');
    const session = $state({ unifiedPickerOpen: false, pendingInput: null,
      update(patch) { Object.assign(this, patch); } });
    const getWorkspaceContext = () => session;
    const runtime = { shouldSuppressFocus: true };
    const localApi = { onQuoteSelection() { return () => {}; } };
    const quotedReplyDraft = text => text;
    const FOCUS_INPUT_EVENT = 'focus-input';
    const requests = [];
    const requestInputFocus = () => requests.push('request');
    globalThis.window = new EventTarget();
    globalThis.requestAnimationFrame = callback => { callback(); return 1; };
    globalThis.CustomEvent = class extends Event {
      constructor(type, options) { super(type); this.detail = options?.detail; }
    };
    ${production}
    const drafts = [{ text: '' }, { text: '' }];
    const focused = [];
    const destroy = $effect.root(() => {
      ['first', 'second'].forEach((name, index) => useComposerFocus({
        active: () => shown === name, isPrimary: () => false,
        isReadOnly: () => false, ownsVoice: () => false,
        voiceState: () => 'idle', showWaveform: () => false,
        session: () => undefined, editor: () => ({ focus() { focused.push(name); } }),
        prompt: () => drafts[index], tabId: () => 'same-tab',
        receivesFocusedInput: () => true, isFocusedPaneComposer: () => true,
        refocusComposer() {},
      }));
    });
    flushSync();
    session.pendingInput = 'First visible draft'; flushSync();
    assert.deepEqual(drafts, [{ text: 'First visible draft' }, { text: '' }]);
    window.dispatchEvent(new CustomEvent(FOCUS_INPUT_EVENT));
    assert.deepEqual(focused, ['first']);
    shown = 'second'; flushSync();
    session.pendingInput = 'Second visible draft'; flushSync();
    assert.deepEqual(drafts, [{ text: 'First visible draft' }, { text: 'Second visible draft' }]);
    window.dispatchEvent(new CustomEvent(FOCUS_INPUT_EVENT));
    assert.deepEqual(focused, ['first', 'second']);
    shown = null; flushSync();
    session.pendingInput = 'Wait for a visible composer'; flushSync();
    assert.equal(session.pendingInput, 'Wait for a visible composer');
    window.dispatchEvent(new CustomEvent(FOCUS_INPUT_EVENT));
    assert.deepEqual(focused, ['first', 'second']);
    destroy();
    window.dispatchEvent(new CustomEvent(FOCUS_INPUT_EVENT));
    assert.deepEqual(focused, ['first', 'second']);
  `
  const directory = mkdtempSync(join(tmpdir(), 'solus-composer-visibility-'))
  try {
    const transpiler = new Bun.Transpiler({ loader: 'ts' })
    const compiled = compileModule(transpiler.transformSync(harness), {
      filename: 'composer-focus.svelte.js', generate: 'client',
    }).js.code
      .replaceAll(/(['"])svelte\/internal\/client\1/g, JSON.stringify(new URL('node_modules/svelte/src/internal/client/index.js', root).href))
      .replaceAll(/(['"])svelte\1/g, JSON.stringify(new URL('node_modules/svelte/src/index-client.js', root).href))
    const path = join(directory, 'focus.mjs')
    writeFileSync(path, compiled)
    const child = Bun.spawn([process.execPath, path], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

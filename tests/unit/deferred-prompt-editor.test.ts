import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from 'svelte/compiler'

/**
 * The prompt editor (CodeMirror) is not part of the first screen's code: it
 * loads beside it. A person who types before it arrives must lose nothing.
 * The stand-in field takes their text and their Enter, and the editor takes
 * the draft and the focus when it runs. A composer mounted after the editor
 * has loaded draws the editor at once, never the stand-in.
 */
test('text and focus typed before the editor loads move to the editor', async () => {
  const root = new URL('../../', import.meta.url)
  const directory = mkdtempSync(join(tmpdir(), 'solus-deferred-editor-'))
  const client = new URL('node_modules/svelte/src/index-client.js', root).href
  function component(source: string, name: string) {
    const code = compile(source, { filename: `${name}.svelte`, generate: 'client' }).js.code
      .replaceAll(/(['"])svelte\/internal\/client\1/g, JSON.stringify(new URL('node_modules/svelte/src/internal/client/index.js', root).href))
      .replaceAll(/(['"])svelte\1/g, JSON.stringify(client))
      .replaceAll(/import ['"]svelte\/internal\/disclose-version['"];?/g, '')
    const path = join(directory, `${name}.mjs`)
    writeFileSync(path, code)
    return path
  }
  try {
    // The editor's stand-in for this test: it shows the value it was given and counts focus calls.
    const editor = component(`<script>
      let { value } = $props();
      export function focus() { globalThis.editorFocusCalls += 1; }
    </script>
    <div data-editor>{value}</div>`, 'editor')
    const source = readFileSync(new URL('packages/workspace-ui/src/components/ui/DeferredPromptEditor.svelte', root), 'utf8')
    // The test decides when the editor's code arrives.
    if (!source.includes('import("./PromptEditor.svelte")')) throw new Error('DeferredPromptEditor no longer loads ./PromptEditor.svelte')
    const deferred = component(source.replace('import("./PromptEditor.svelte")', 'globalThis.editorLoad'), 'deferred')
    const host = component(`<script>
      import DeferredPromptEditor from ${JSON.stringify(deferred)};
      let value = $state('');
      let editor = $state(null);
      globalThis.draft = () => value;
      globalThis.focusComposer = () => editor.focus();
    </script>
    <DeferredPromptEditor bind:this={editor} {value} onValueChange={(next) => (value = next)}
      onKeyDown={(event) => globalThis.keys.push(event.key)} placeholder="Ask anything" />`, 'host')
    const runner = join(directory, 'test.mjs')
    writeFileSync(runner, `
      import assert from 'node:assert/strict';
      import { JSDOM } from ${JSON.stringify(new URL('node_modules/jsdom/lib/api.js', root).href)};
      const dom = new JSDOM('<!doctype html><body></body>');
      for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Text', 'Comment', 'Event', 'CustomEvent', 'KeyboardEvent', 'InputEvent', 'HTMLMediaElement', 'HTMLTextAreaElement', 'navigator']) globalThis[key] = dom.window[key];
      globalThis.editorFocusCalls = 0;
      globalThis.keys = [];
      let arrive;
      globalThis.editorLoad = new Promise((resolve) => (arrive = resolve));
      const { mount, unmount, flushSync, tick } = await import(${JSON.stringify(client)});
      const { default: Host } = await import(${JSON.stringify(host)});

      const first = mount(Host, { target: document.body });
      flushSync();
      const field = document.querySelector('textarea');
      assert.ok(field, 'the stand-in field is there before the editor');
      assert.equal(field.getAttribute('placeholder'), 'Ask anything');
      focusComposer();
      assert.equal(document.activeElement, field, 'a focus request lands on the stand-in');
      field.value = 'Fix the flaky test';
      field.dispatchEvent(new InputEvent('input', { bubbles: true }));
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      flushSync();
      assert.equal(draft(), 'Fix the flaky test');
      assert.deepEqual(keys, ['Enter'], 'Enter reaches the composer, so it can send');

      const { default: Editor } = await import(${JSON.stringify(editor)});
      arrive({ default: Editor });
      await tick(); await tick();
      flushSync();
      assert.equal(document.querySelector('textarea'), null, 'the stand-in goes when the editor runs');
      assert.equal(document.querySelector('[data-editor]').textContent, 'Fix the flaky test', 'the editor takes the draft');
      assert.equal(editorFocusCalls, 1, 'the editor takes the focus the stand-in had');
      await unmount(first);

      const second = mount(Host, { target: document.body });
      flushSync();
      assert.equal(document.querySelector('textarea'), null, 'a later composer never draws the stand-in');
      assert.ok(document.querySelector('[data-editor]'));
      assert.equal(editorFocusCalls, 1, 'nothing asked the later editor for focus');
      await unmount(second);
      dom.window.close();
    `)
    const child = Bun.spawn([process.execPath, runner], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: '', stderr: '' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

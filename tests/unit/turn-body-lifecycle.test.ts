import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from 'svelte/compiler'

test('folded history mounts on demand and retains the same content after folding', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'solus-turn-body-'))
  const root = new URL('../../', import.meta.url)
  const client = new URL('node_modules/svelte/src/index-client.js', root).href
  const internal = new URL('node_modules/svelte/src/internal/client/index.js', root).href
  const jsdom = new URL('node_modules/jsdom/lib/api.js', root).href
  function component(source: string, name: string): string {
    const path = join(directory, name)
    const code = compile(source, { filename: path, generate: 'client', dev: false }).js.code
      .replaceAll(/(['"])svelte\/internal\/client\1/g, JSON.stringify(internal))
      .replaceAll(/(['"])svelte\1/g, JSON.stringify(client))
      .replaceAll(/import ['"]svelte\/internal\/disclose-version['"];?/g, '')
    writeFileSync(path, code)
    return path
  }
  try {
    const body = component(readFileSync(new URL('packages/workspace-ui/src/components/conversation/TurnBody.svelte', root), 'utf8'), 'body.mjs')
    const fixture = component(`<script>
      import TurnBody from ${JSON.stringify(body)};
      let { initiallyVisible = false } = $props();
      let live = $state(initiallyVisible);
      let expanded = $state(false);
    </script>
    <button onclick={() => expanded = !expanded}>Expand</button>
    <button onclick={() => live = !live}>Live</button>
    <div hidden={!live && !expanded}>
      <TurnBody visible={live || expanded}>
        <textarea aria-label="Retained draft"></textarea>
      </TurnBody>
    </div>`, 'fixture.mjs')
    const runner = join(directory, 'run.mjs')
    writeFileSync(runner, `
      import assert from 'node:assert/strict';
      import { JSDOM } from ${JSON.stringify(jsdom)};
      const dom = new JSDOM('<!doctype html><body></body>');
      for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Text', 'Comment', 'Event']) globalThis[key] = dom.window[key];
      const { mount, unmount, flushSync } = await import(${JSON.stringify(client)});
      const { default: Fixture } = await import(${JSON.stringify(fixture)});
      for (const initiallyVisible of [false, true]) {
        const target = document.createElement('div'); document.body.append(target);
        const app = mount(Fixture, { target, props: { initiallyVisible } }); flushSync();
        const [expand, live] = target.querySelectorAll('button');
        // A historical body's expensive child must not exist until requested.
        if (!initiallyVisible) {
          assert.equal(target.querySelector('textarea'), null);
          expand.click(); flushSync();
        }
        const input = target.querySelector('textarea'); assert.ok(input);
        input.value = 'Keep this draft';
        if (initiallyVisible) live.click(); else expand.click();
        flushSync();
        assert.equal(input.parentElement.hidden, true);
        assert.equal(target.querySelector('textarea'), input);
        expand.click(); flushSync();
        assert.equal(input.parentElement.hidden, false);
        assert.equal(target.querySelector('textarea'), input);
        assert.equal(input.value, 'Keep this draft');
        await unmount(app); assert.equal(target.querySelector('textarea'), null);
        target.remove();
      }
      dom.window.close();
    `)
    const child = Bun.spawn([process.execPath, runner], { stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ stdout, stderr, exitCode }).toEqual({ stdout: '', stderr: '', exitCode: 0 })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

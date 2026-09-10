import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from 'svelte/compiler'

test('replacement states keep the saved guide mounted and outdated visible', async () => {
  const root = new URL('../../', import.meta.url)
  const directory = mkdtempSync(join(tmpdir(), 'solus-guide-surface-'))
  const client = new URL('node_modules/svelte/src/index-client.js', root).href
  const internal = new URL('node_modules/svelte/src/internal/client/index.js', root).href
  function component(source: string, name: string) {
    const code = compile(source, { filename: `${name}.svelte`, generate: 'client' }).js.code
      .replaceAll(/(['"])svelte\/internal\/client\1/g, JSON.stringify(internal))
      .replaceAll(/import ['"]svelte\/internal\/disclose-version['"];?/g, '')
    const path = join(directory, `${name}.mjs`)
    writeFileSync(path, code)
    return path
  }
  try {
    const stub = component('<span></span>', 'stub')
    const guide = component('<script>let { guide } = $props();</script><article>{guide.title}</article>', 'guide')
    const button = component('<script>let { children, ...props } = $props();</script><button {...props}>{@render children?.()}</button>', 'button')
    const source = readFileSync(new URL('packages/workspace-ui/src/components/review/GuideSurface.svelte', root), 'utf8')
      .replace(/^  import .*?;\n/gm, '')
      .replace('<script lang="ts">', `<script lang="ts">
        import GuideView from ${JSON.stringify(guide)};
        import Button from ${JSON.stringify(button)};
        import Stub from ${JSON.stringify(stub)};
        const ClockIcon = Stub, ReviewGuideGlyph = Stub, ReviewProgress = Stub;
      `)
    const surface = component(source, 'surface')
    const harness = component(`<script>
      import Surface from ${JSON.stringify(surface)};
      let status = $state('ready');
      let unavailable = $state(false);
      let loader = $state({ guide: { title: 'Saved guide', sections: [] }, stale: false, loading: false, progressStep: 'preparing', error: null, freshnessUnknown: false });
      let retries = 0;
      export function update(next, stale = false, disconnected = false) { status = next; loader.stale = stale; unavailable = disconnected; }
      export function unknown() { loader.freshnessUnknown = true; }
      export function clearGuide() { loader.guide = null; }
      export function retryCount() { return retries; }
    </script><Surface {loader} generationStatus={status} {unavailable} onGenerate={() => retries++} />`, 'harness')
    const runner = join(directory, 'test.mjs')
    writeFileSync(runner, `
      import assert from 'node:assert/strict';
      import { JSDOM } from ${JSON.stringify(new URL('node_modules/jsdom/lib/api.js', root).href)};
      const dom = new JSDOM('<!doctype html><body></body>');
      for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Text', 'Comment', 'Event', 'CustomEvent']) globalThis[key] = dom.window[key];
      const { mount, unmount, flushSync } = await import(${JSON.stringify(client)});
      const { default: Harness } = await import(${JSON.stringify(harness)});
      const app = mount(Harness, { target: document.body });
      flushSync();
      const saved = document.querySelector('article');
      assert.ok(saved);
      for (const status of ['queued', 'generating', 'failed', 'cancelled']) {
        app.update(status, true);
        flushSync();
        assert.equal(document.querySelector('article'), saved);
        assert.ok(document.body.textContent.includes('Outdated'));
        if (status === 'queued' || status === 'generating') {
          assert.ok(document.body.textContent.includes('Generating replacement'));
          assert.equal([...document.querySelectorAll('button')].find(b => b.textContent === 'Regenerate').disabled, true);
        } else {
          [...document.querySelectorAll('button')].find(b => b.textContent === 'Retry').click();
        }
      }
      assert.equal(app.retryCount(), 2);
      app.update('generating', true, true);
      flushSync();
      assert.ok(document.body.textContent.includes('Guide status unavailable'));
      assert.equal(document.querySelector('article'), saved);
      app.update('ready');
      flushSync();
      assert.ok(!document.body.textContent.includes('Outdated'));
      assert.ok(!document.body.textContent.includes('Generating replacement'));
      app.unknown();
      flushSync();
      assert.ok(document.body.textContent.includes('Cannot check whether this guide is current'));
      app.clearGuide();
      app.update('outdated');
      flushSync();
      assert.ok(document.body.textContent.includes('The PR changed during generation'));
      assert.ok([...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Regenerate'));
      await unmount(app);
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

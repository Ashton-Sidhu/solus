import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from 'svelte/compiler'

// WHY: an app's UI is in a frame, and a frame that is removed and made again
// loads its page again and loses what the person typed. The Manage page shows
// in place of the app (docs/plans/apps.md §9.1), so the app's view must be
// hidden while it shows, never unmounted.
test('the app stays mounted, hidden, while the Manage page shows', async () => {
  const root = new URL('../../', import.meta.url)
  const directory = mkdtempSync(join(tmpdir(), 'solus-app-view-stack-'))
  const client = new URL('node_modules/svelte/src/index-client.js', root).href
  const internal = new URL('node_modules/svelte/src/internal/client/index.js', root).href
  function component(source: string, name: string): string {
    const path = join(directory, `${name}.mjs`)
    const code = compile(source, { filename: `${name}.svelte`, generate: 'client', dev: false, runes: true }).js.code
      .replaceAll(/(['"])svelte\/internal\/client\1/g, JSON.stringify(internal))
      .replaceAll(/(['"])svelte\1/g, JSON.stringify(client))
      .replaceAll(/import ['"]svelte\/internal\/disclose-version['"];?/g, '')
    writeFileSync(path, code)
    return path
  }
  try {
    const stack = component(readFileSync(new URL('packages/workspace-ui/src/components/app/AppViewStack.svelte', root), 'utf8'), 'stack')
    const fixture = component(`<script>
      import AppViewStack from ${JSON.stringify(stack)};
      let view = $state('app');
    </script>
    <button onclick={() => view = view === 'app' ? 'manage' : 'app'}>Switch</button>
    <AppViewStack {view}>
      {#snippet appContent()}<iframe title="app"></iframe>{/snippet}
      {#snippet manageContent()}<p data-manage>Manage</p>{/snippet}
    </AppViewStack>`, 'fixture')
    const runner = join(directory, 'run.ts')
    writeFileSync(runner, `
      import assert from 'node:assert/strict';
      import { JSDOM } from ${JSON.stringify(new URL('node_modules/jsdom/lib/api.js', root).href)};
      const dom = new JSDOM('<!doctype html><body></body>');
      for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Text', 'Comment', 'Event']) globalThis[key] = dom.window[key];
      const { mount, unmount, flushSync } = await import(${JSON.stringify(client)});
      const { default: Fixture } = await import(${JSON.stringify(fixture)});
      const target = document.createElement('div'); document.body.append(target);
      const app = mount(Fixture, { target });
      flushSync();
      const button = target.querySelector('button');
      const frame = target.querySelector('iframe');
      const hidden = (el) => !!el.closest('[hidden]');
      assert.ok(frame && !hidden(frame), 'the app shows first');
      assert.equal(target.querySelector('[data-manage]'), null, 'the Manage page is not there before it is asked for');

      button.click(); flushSync();
      assert.equal(target.querySelector('iframe'), frame, 'the frame is the same element while Manage shows');
      assert.ok(frame.isConnected && hidden(frame), 'the frame is in the document, hidden');
      assert.ok(target.querySelector('[data-manage]') && !hidden(target.querySelector('[data-manage]')), 'the Manage page shows');

      button.click(); flushSync();
      assert.equal(target.querySelector('iframe'), frame, 'the frame is the same element when the app shows again');
      assert.ok(!hidden(frame), 'the app shows again');
      assert.equal(target.querySelector('[data-manage]'), null, 'the Manage page goes: it reads again when it opens');
      await unmount(app);
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

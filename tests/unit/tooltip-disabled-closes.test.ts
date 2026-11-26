import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile, compileModule } from 'svelte/compiler'

/**
 * The session sidebar disables its row tooltips while a click opens a session
 * and while Settings is open. bits-ui keeps an open tooltip open when it is
 * disabled, and a disabled trigger ignores the pointer that leaves it, so the
 * tooltip stayed on screen after the person had navigated away. The tooltip
 * root must close when it becomes disabled, and must not come back when it is
 * enabled again: the pointer that opened it is gone.
 */
test('a tooltip that becomes disabled closes and stays closed when enabled again', async () => {
  const root = new URL('../../', import.meta.url)
  const directory = mkdtempSync(join(tmpdir(), 'solus-tooltip-disabled-'))
  const client = new URL('node_modules/svelte/src/index-client.js', root).href
  const internal = new URL('node_modules/svelte/src/internal/client/index.js', root).href
  function rewrite(code: string) {
    return code
      .replaceAll(/(['"])svelte\/internal\/client\1/g, JSON.stringify(internal))
      .replaceAll(/(['"])svelte\1/g, JSON.stringify(client))
      .replaceAll(/import ['"]svelte\/internal\/disclose-version['"];?/g, '')
  }
  function write(name: string, code: string) {
    const path = join(directory, `${name}.mjs`)
    writeFileSync(path, rewrite(code))
    return path
  }
  try {
    // The bits-ui root, reduced to what this rule reads: hover opens it unless disabled.
    const primitiveRoot = write('primitive-root', compile(`<script>
      let { open = $bindable(false), disabled } = $props();
    </script>
    <button data-open={String(open)} onpointerenter={() => { if (!disabled) open = true; }}></button>`,
    { filename: 'primitive-root.svelte', generate: 'client' }).js.code)
    const bits = join(directory, 'bits-ui.mjs')
    writeFileSync(bits, `import Root from ${JSON.stringify(primitiveRoot)}; export const Tooltip = { Root };`)
    const props = write('props', compileModule('export const props = $state({ disabled: false });',
      { filename: 'props.svelte.js', generate: 'client' }).js.code)
    const source = readFileSync(new URL('packages/workspace-ui/src/components/ui/tooltip/tooltip.svelte', root), 'utf8')
      .replace(/from "bits-ui"/, `from ${JSON.stringify(bits)}`)
    const tooltip = write('tooltip', compile(source, { filename: 'tooltip.svelte', generate: 'client' }).js.code)
    const runner = join(directory, 'test.mjs')
    writeFileSync(runner, `
      import assert from 'node:assert/strict';
      import { JSDOM } from ${JSON.stringify(new URL('node_modules/jsdom/lib/api.js', root).href)};
      const dom = new JSDOM('<!doctype html><body></body>');
      for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Text', 'Comment', 'Event', 'CustomEvent', 'HTMLMediaElement']) globalThis[key] = dom.window[key];
      const { mount, unmount, flushSync } = await import(${JSON.stringify(client)});
      const { props } = await import(${JSON.stringify(props)});
      const { default: Tooltip } = await import(${JSON.stringify(tooltip)});
      const app = mount(Tooltip, { target: document.body, props });
      flushSync();
      const trigger = () => document.querySelector('button');

      trigger().dispatchEvent(new dom.window.Event('pointerenter'));
      flushSync();
      assert.equal(trigger().dataset.open, 'true');

      props.disabled = true;
      flushSync();
      assert.equal(trigger().dataset.open, 'false', 'a disabled tooltip must close');

      props.disabled = false;
      flushSync();
      assert.equal(trigger().dataset.open, 'false', 'enabling it again must not reopen it');

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
}, 60_000)

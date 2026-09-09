import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from 'svelte/compiler'

test('undo remounts a diagram node view with the document context', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'solus-diagram-undo-'))
  const root = new URL('../../', import.meta.url)
  const client = new URL('node_modules/svelte/src/index-client.js', root).href
  const internal = new URL('node_modules/svelte/src/internal/client/index.js', root).href
  try {
    // Stand in for the canvas, which also requires the document's settings context.
    const preview = join(directory, 'preview.mjs')
    const compiled = compile(`<script>
      import { getContext } from 'svelte';
      let { workId } = $props();
      const settings = getContext('settings');
    </script><div data-preview={workId}>{settings.label}</div>`, { generate: 'client', dev: false }).js.code
      .replaceAll(/(['"])svelte\/internal\/client\1/g, JSON.stringify(internal))
      .replaceAll(/(['"])svelte\1/g, JSON.stringify(client))
      .replaceAll(/import ['"]svelte\/internal\/disclose-version['"];?/g, '')
    writeFileSync(preview, compiled)
    const extension = join(directory, 'extension.mjs')
    const source = readFileSync(new URL('packages/workspace-ui/src/components/editor/diagramEmbedExtension.ts', root), 'utf8')
      .replace("'./DiagramEmbedNodeView.svelte'", JSON.stringify(preview))
      .replace("'svelte'", JSON.stringify(client))
      .replace("'@tiptap/core'", JSON.stringify(new URL('node_modules/@tiptap/core/dist/index.js', root).href))
      .replace("'@solus/contracts/diagram-embed'", JSON.stringify(new URL('packages/contracts/src/diagram-embed.ts', root).href))
    writeFileSync(extension, new Bun.Transpiler({ loader: 'ts' }).transformSync(source))
    const runner = join(directory, 'run.mjs')
    writeFileSync(runner, `
      import assert from 'node:assert/strict';
      import { JSDOM } from ${JSON.stringify(new URL('node_modules/jsdom/lib/api.js', root).href)};
      const dom = new JSDOM('<!doctype html><body></body>');
      for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Text', 'Comment', 'Event', 'MutationObserver', 'getComputedStyle', 'navigator']) globalThis[key] = dom.window[key];
      const { flushSync } = await import(${JSON.stringify(client)});
      const { Editor } = await import(${JSON.stringify(new URL('node_modules/@tiptap/core/dist/index.js', root).href)});
      const { default: StarterKit } = await import(${JSON.stringify(new URL('node_modules/@tiptap/starter-kit/dist/index.js', root).href)});
      const { createDiagramEmbedExtension } = await import(${JSON.stringify(extension)});
      const editor = new Editor({
        element: document.body.appendChild(document.createElement('div')),
        extensions: [StarterKit, createDiagramEmbedExtension({
          contexts: new Map([['settings', { label: 'Rendered diagram' }]]),
          worksStore: { works: {}, ensureContent: async () => null },
          onOpen() {}, onOpenSecondary() {},
        })],
        content: { type: 'doc', content: [{ type: 'diagramEmbed', attrs: { workId: 'd1', title: 'Diagram' } }] },
      });
      flushSync();
      assert.equal(document.querySelector('[data-preview="d1"]').textContent, 'Rendered diagram');
      editor.commands.setContent('<p>Pulled text</p>', { emitUpdate: false });
      flushSync();
      assert.equal(document.querySelector('[data-preview]'), null);
      assert.equal(editor.commands.undo(), true);
      flushSync();
      assert.equal(document.querySelector('[data-preview="d1"]').textContent, 'Rendered diagram');
      editor.destroy(); flushSync(); dom.window.close();
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

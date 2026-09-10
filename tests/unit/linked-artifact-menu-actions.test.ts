import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from 'svelte/compiler'

// The rail's linked-artifact menu acts on the row the rail holds in the same
// state the menu's close clears. `{@const menu = linkMenu}` is a derived, so an
// action that runs after the close reads it back as null and throws before it
// ever reaches the clipboard — the row's Copy Reference silently did nothing.
// This mounts the real rail section and the real menu together and asserts each
// action still receives its link.
test('a linked row menu acts on its link before the rail drops the menu', async () => {
  const root = new URL('../../', import.meta.url)
  const directory = mkdtempSync(join(tmpdir(), 'solus-linked-menu-'))
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
    const pass = component('<script>let { children } = $props();</script>{@render children?.()}', 'pass')
    const childSlot = component(
      '<script>let { child } = $props();</script>{@render child?.({ props: {} })}',
      'childSlot',
    )
    // Stands in for bits-ui only: a menu item is a control whose activation
    // runs `onSelect`. Which primitive draws it is not what this test pins.
    const item = component(
      '<script>let { children, onSelect } = $props();</script><button onclick={() => onSelect?.()}>{@render children?.()}</button>',
      'item',
    )

    const menuSource = readFileSync(
      new URL('packages/workspace-ui/src/components/project-panel/LinkedArtifactContextMenu.svelte', root),
      'utf8',
    )
      .replace(/import \{[\s\S]*?\} from "@lucide\/svelte";/, '')
      .replace(/import \* as ContextMenu from "\.\.\/ui\/context-menu";/, '')
      .replace(
        '<script lang="ts">',
        `<script lang="ts">
          import Stub from ${JSON.stringify(stub)};
          import Pass from ${JSON.stringify(pass)};
          import Item from ${JSON.stringify(item)};
          const CopyIcon = Stub, OpenIcon = Stub, UnlinkIcon = Stub;
          const ContextMenu = { Root: Pass, PointTrigger: Stub, Content: Pass, Item, Separator: Stub };
        `,
      )
    const menu = component(menuSource, 'menu')

    const sectionSource = readFileSync(
      new URL('packages/workspace-ui/src/components/project-panel/TaskSection.svelte', root),
      'utf8',
    )
      .replace(/^  import .*?;\n/gm, '')
      .replace(
        '<script lang="ts">',
        `<script lang="ts">
          import ChildSlot from ${JSON.stringify(childSlot)};
          import Stub from ${JSON.stringify(stub)};
          import Pass from ${JSON.stringify(pass)};
          import LinkedArtifactContextMenu from ${JSON.stringify(menu)};
          const seedLink = { taskId: 't1', kind: 'work', targetScope: '', targetKey: 'work-9', title: 'Design doc', url: 'https://solus.test/work/work-9', createdBy: 'user', linkedAt: 0 };
          const record = {
            details: { links: [seedLink] },
            serverId: 'server-1',
            unlink: (...args) => { globalThis.__unlinked = args; return Promise.resolve(); },
          };
          const getWorkspaceContext = () => ({
            tasksStore: { get: () => record },
            automationsStore: { get: () => undefined },
            ctxForDirectory: () => ({}),
            openWorkModal: (key) => { globalThis.__opened = key; return Promise.resolve(); },
          });
          const getPullRequestsContext = () => ({ projects: { at: () => undefined, get: () => ({ ensureNumbers: () => {} }) } });
          const serverConnections = { apiFor: () => ({}) };
          const TooltipUI = { Root: Pass, Trigger: ChildSlot, Content: Stub };
          const requestInputFocus = () => {};
          const copyText = (text) => { globalThis.__copied = text; return Promise.resolve(); };
          const toasts = { success: () => {}, error: () => {} };
          const linkedPrNavigationTarget = () => ({ serverId: 'server-1', projectDirectory: '/repo' });
          const railLinkList = (links) => ({
            total: links.length,
            rows: links.map((entry, index) => ({ key: String(index), icon: Stub, label: entry.title, detailLabel: entry.title, link: entry })),
          });
        `,
      )
    const section = component(sectionSource, 'section')

    const runner = join(directory, 'test.mjs')
    writeFileSync(
      runner,
      `
      import assert from 'node:assert/strict';
      import { JSDOM } from ${JSON.stringify(new URL('node_modules/jsdom/lib/api.js', root).href)};
      const dom = new JSDOM('<!doctype html><body></body>');
      for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Text', 'Comment', 'Event', 'CustomEvent', 'MouseEvent', 'PointerEvent']) globalThis[key] = dom.window[key];
      const { mount, flushSync } = await import(${JSON.stringify(client)});
      const { default: Section } = await import(${JSON.stringify(section)});
      mount(Section, { target: document.body, props: { task: { id: 't1', status: 'todo', projectKey: '/repo' }, projectCwd: '/repo' } });
      flushSync();

      function openMenu() {
        const row = document.querySelector('div > button');
        row.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 20 }));
        flushSync();
        return [...document.querySelectorAll('button')].slice(1);
      }
      function choose(label) {
        const entry = openMenu().find(button => button.textContent.trim() === label);
        assert.ok(entry, 'no menu entry labelled ' + label);
        entry.click();
        flushSync();
        // The menu is the rail's, and it leaves with the action.
        assert.equal(openMenu().length > 0, true);
      }

      choose('Copy Reference');
      assert.equal(globalThis.__copied, 'https://solus.test/work/work-9');
      choose('Open');
      assert.equal(globalThis.__opened, 'work-9');
      choose('Unlink');
      assert.deepEqual(globalThis.__unlinked, ['work', 'work-9', '']);
      console.log('ok');
      `,
    )
    const result = Bun.spawnSync(['bun', runner], { stdout: 'pipe', stderr: 'pipe' })
    expect(new TextDecoder().decode(result.stderr)).toBe('')
    expect(new TextDecoder().decode(result.stdout).trim()).toBe('ok')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

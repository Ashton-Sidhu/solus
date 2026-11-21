import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile, compileModule } from 'svelte/compiler'

/**
 * The picture-in-picture display mode of an MCP App on desktop and web
 * (docs/plans/mcp-first-class.md §14.2), with the real frame component and
 * view state in jsdom. The bridge rules are in mcp-app-host.test.ts.
 */
const directory = mkdtempSync(join(tmpdir(), 'solus-mcp-app-pip-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const root = new URL('../../', import.meta.url)
const client = new URL('node_modules/svelte/src/index-client.js', root).href
const reactivity = new URL('node_modules/svelte/src/reactivity/index-client.js', root).href
const internal = new URL('node_modules/svelte/src/internal/client/index.js', root).href
const transpiler = new Bun.Transpiler({ loader: 'ts' })
const region = 'packages/workspace-ui/src/components/conversation/'
const source = (path: string) => new URL(path, root).href

function executable(code: string): string {
  return code.replaceAll(/(['"])svelte\/internal\/client\1/g, JSON.stringify(internal))
    .replaceAll(/(['"])svelte\/reactivity\1/g, JSON.stringify(reactivity))
    .replaceAll(/(['"])svelte\1/g, JSON.stringify(client))
    .replaceAll(/import ['"]svelte\/internal\/disclose-version['"];?/g, '')
}

function component(code: string, name: string): string {
  const path = join(directory, `${name}.mjs`)
  writeFileSync(path, executable(compile(code, { filename: `${name}.svelte`, generate: 'client' }).js.code))
  return path
}

function svelteModule(path: string, name: string, replacements: Array<[string, string]> = []): string {
  let code = readFileSync(new URL(path, root), 'utf8')
  for (const [from, to] of replacements) code = code.replace(from, to)
  const out = join(directory, `${name}.mjs`)
  writeFileSync(out, executable(compileModule(transpiler.transformSync(code), { filename: `${name}.svelte.js`, generate: 'client' }).js.code))
  return out
}

async function run(script: string): Promise<void> {
  const path = join(directory, `run-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(path, `
    import assert from 'node:assert/strict';
    import { JSDOM } from ${JSON.stringify(source('node_modules/jsdom/lib/api.js'))};
    const dom = new JSDOM('<!doctype html><body></body>');
    for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'HTMLDialogElement', 'HTMLMediaElement', 'Text', 'Comment', 'Event', 'CustomEvent', 'MessageEvent', 'getComputedStyle']) globalThis[key] = dom.window[key];
    ${script}
    dom.window.close();
  `)
  const child = Bun.spawn([process.execPath, path], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: '', stderr: '' })
}

test('one app floats over a conversation, and its turn stays mounted wherever the reader is', async () => {
  const geometry = join(directory, 'geometry.mjs')
  writeFileSync(geometry, transpiler.transformSync(readFileSync(new URL(region + 'lib/transcript-geometry.ts', root), 'utf8')))
  const virtualizer = svelteModule(region + 'lib/transcript-virtualizer.svelte.ts', 'virtualizer', [["'./transcript-geometry'", JSON.stringify(geometry)]])
  const disclosure = svelteModule(region + 'lib/transcript-disclosure.svelte.ts', 'disclosure')
  const mcpAppViews = svelteModule(region + 'lib/mcp-app-views.svelte.ts', 'mcp-app-views')
  const viewState = svelteModule(region + 'lib/conversation-view-state.svelte.ts', 'view-state', [
    ["'./mcp-app-views.svelte'", JSON.stringify(mcpAppViews)],
    ["'./transcript-disclosure.svelte'", JSON.stringify(disclosure)],
    ["'./transcript-virtualizer.svelte'", JSON.stringify(virtualizer)],
  ])
  await run(`
    globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};
    const { ConversationViewState } = await import(${JSON.stringify(viewState)});
    const view = new ConversationViewState();

    const apps = view.mcpApps;

    // WHY: one frame floats over one conversation. A second request puts the first back in its card.
    apps.view('activity-a').showPip('turn-1');
    apps.view('activity-b').showPip('turn-9');
    assert.equal(apps.view('activity-a').isPip, false);
    assert.equal(apps.view('activity-b').isPip, true);
    // A card that is not in picture-in-picture cannot take it from another.
    apps.view('activity-a').returnPip();
    assert.equal(apps.view('activity-b').isPip, true);
    // WHY: a live card that takes its saved app keeps everything the person set up under the activity id,
    // where the saved card reads it: the mode, the height, the grants, the context, and a close.
    const live = apps.view('tool-use-1');
    live.showPip('turn-3');
    live.setHeight(480);
    live.grant(['camera']);
    live.setModelContext('Map of Paris');
    live.close();
    apps.adopt('tool-use-1', 'activity-c');
    const saved = apps.view('activity-c');
    assert.equal(saved.isPip, true);
    assert.equal(saved.height, 480);
    assert.deepEqual(saved.permissions, ['camera']);
    assert.equal(saved.modelContext, 'Map of Paris');
    assert.equal(saved.isClosed, true);
    assert.equal(live.isClosed, false);
    assert.equal(live.height, undefined);
    saved.show();
    // The same view comes back for a key: a card reads it in its template.
    assert.equal(apps.view('activity-c'), saved);

    // The virtualizer keeps the frame's turn mounted far from the reader, or the frame would go with the row.
    const keys = Array.from({ length: 2000 }, (_, index) => 'turn-' + index);
    view.virtualizer.setKeys(keys);
    const scroll = document.createElement('div');
    const content = document.createElement('div');
    scroll.append(content);
    document.body.append(scroll);
    Object.defineProperty(scroll, 'clientHeight', { get: () => 800 });
    Object.defineProperty(scroll, 'scrollHeight', { get: () => 2000 * 240 });
    let scrollTop = 0;
    Object.defineProperty(scroll, 'scrollTop', { get: () => scrollTop, set(value) { scrollTop = value; } });
    HTMLElement.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, height: 0 });
    content.getBoundingClientRect = () => ({ top: -scrollTop, bottom: 2000 * 240 - scrollTop, height: 2000 * 240 });
    const disconnect = view.virtualizer.connect(scroll, content);
    // What the virtualizer does after each frame of the reader's scroll.
    const read = () => view.virtualizer['refresh']();
    scroll.scrollTop = 400000;
    read();
    assert.ok(view.virtualizer.range.start > 100, 'the reader is far from the turn: ' + JSON.stringify(view.virtualizer.range));
    assert.ok(view.virtualizer.pinnedKeys.includes('turn-3'));
    saved.returnPip();
    read();
    assert.ok(!view.virtualizer.pinnedKeys.includes('turn-3'), 'a turn given back to its card is no longer kept');
    disconnect();
  `)
}, 60_000)

test('the frame changes mode in place, belongs to its conversation, and gives the focus back to the input bar', async () => {
  const empty = component('<script>let { children } = $props();</script>{@render children?.()}', 'empty')
  const button = component('<script>let { children, ref = $bindable(null), variant, size, ...props } = $props();</script><button bind:this={ref} {...props}>{@render children?.()}</button>', 'button')
  const stubs = join(directory, 'stubs.mjs')
  writeFileSync(stubs, `
    export const settings = { isDark: false };
    export const getSettingsContext = () => settings;
    export let focusRequests = 0;
    export const requestInputFocus = () => { focusRequests++; };
  `)
  const frameSource = readFileSync(new URL(region + 'McpAppFrame.svelte', root), 'utf8')
    .replace(/^ {2}import .*?;\n/gm, '')
    .replace('<script lang="ts">', `<script lang="ts">
      import { tick, untrack } from 'svelte';
      import Button from ${JSON.stringify(button)};
      import Empty from ${JSON.stringify(empty)};
      import { getSettingsContext, requestInputFocus } from ${JSON.stringify(stubs)};
      import { MCP_APP_PIP_MIN_CONVERSATION_WIDTH, mcpAppAvailableDisplayModes } from ${JSON.stringify(source('packages/client-core/src/mcp-app-context.ts'))};
      import { mcpAppFrameHeight } from ${JSON.stringify(source('packages/client-core/src/mcp-app-document.ts'))};
      import { mcpAppOffersDisplayMode } from ${JSON.stringify(source('packages/client-core/src/mcp-app-host.ts'))};
      import { mcpAppAllowAttribute, mcpAppPermissionAction, mcpAppPermissionPrompt, mcpAppPermissionRequest } from ${JSON.stringify(source('packages/client-core/src/mcp-app-permissions.ts'))};
      import { mcpAppDocument } from ${JSON.stringify(source('packages/contracts/src/mcp-apps.ts'))};
      import { connectMcpAppFrame, mcpAppContext, mcpAppSupportedPermissions, mcpAppTurnKey } from ${JSON.stringify(source(region + 'lib/mcp-app-frame.ts'))};
      const localApi = { openExternal: async () => {} };
      const ArrowLeftRight = Empty, Bot = Empty, ChevronDown = Empty, ChevronRight = Empty, Maximize = Empty, Minimize = Empty, Minimize2 = Empty, PictureInPicture2 = Empty, Shield = Empty, X = Empty;
    `)
  const frame = component(frameSource, 'frame')
  // The card's part: the view state says which app floats, as McpAppCard does.
  const fixture = component(`<script>
    import McpAppFrame from ${JSON.stringify(frame)};
    let pip = $state(null);
    export function takenByAnotherApp() { pip = 'another-activity'; }
    export function pipKey() { return pip; }
    const view = {
      get isPip() { return pip === 'activity-1'; },
      pipSide: 'end',
      height: undefined,
      modelContext: undefined,
      permissions: [],
      showPip: () => { pip = 'activity-1'; },
      returnPip: () => { if (pip === 'activity-1') pip = null; },
      movePip: () => {},
      setHeight: () => {},
      setModelContext: () => {},
      grant: () => {},
      close: () => {},
    };
  </script>
  <div data-slot="conversation">
    <div data-transcript-turn-id="turn-7">
      <McpAppFrame
        snapshot={{ html: '<p>Map</p>', toolInputJson: '{}', toolResultJson: '{}', csp: {} }}
        api={{}} request={{ sessionId: 's', activityId: 'activity-1' }} title="Map"
        onSend={() => true} {view}
      />
    </div>
  </div>`, 'fixture')
  await run(`
    // jsdom has no dialog methods and no layout.
    HTMLDialogElement.prototype.show = function () { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); this.dataset.modal = 'true'; };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); delete this.dataset.modal; };
    HTMLElement.prototype.scrollIntoView = function () {};
    const observers = [];
    globalThis.ResizeObserver = class { constructor(callback) { this.callback = callback; observers.push(this); } observe(node) { this.node = node; } disconnect() {} };
    let conversationWidth = 800;
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return this.dataset?.slot === 'conversation' ? conversationWidth : 640; } });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 320; } });
    const resize = () => { for (const observer of observers) observer.callback([]); };

    const { mount, unmount, flushSync, tick } = await import(${JSON.stringify(client)});
    const stubs = await import(${JSON.stringify(stubs)});
    const { default: Fixture } = await import(${JSON.stringify(fixture)});
    const app = mount(Fixture, { target: document.body });
    flushSync();
    const iframe = document.querySelector('iframe');
    const dialog = document.querySelector('dialog[aria-label="Map"]');
    const posted = [];
    iframe.contentWindow.postMessage = (message) => posted.push(message);
    const fromApp = (message) => window.dispatchEvent(new MessageEvent('message', { data: { jsonrpc: '2.0', ...message }, source: iframe.contentWindow }));
    fromApp({ id: 1, method: 'ui/initialize', params: { appCapabilities: { availableDisplayModes: ['inline', 'fullscreen', 'pip'] } } });
    fromApp({ method: 'ui/notifications/initialized' });
    await tick(); flushSync();
    resize(); flushSync();
    const keepInView = () => document.querySelector('[aria-label="Keep in view"]');
    assert.equal(posted.find((message) => message.id === 1).result.hostContext.displayMode, 'inline');

    // WHY: the person can ask for picture-in-picture beside full screen; typing is next, so the input bar gets the focus.
    keepInView().click();
    flushSync(); await tick(); flushSync();
    assert.equal(app.pipKey(), 'activity-1');
    assert.equal(dialog.dataset.mcpAppMode, 'pip');
    assert.equal(stubs.focusRequests, 1);
    // WHY: the app keeps its state. The frame is the same element, still in its conversation, so it never loads again;
    // a hidden conversation hides it with the rest of the conversation.
    assert.equal(document.querySelector('iframe'), iframe);
    assert.ok(document.querySelector('[data-slot="conversation"]').contains(dialog));
    assert.equal(dialog.dataset.modal, undefined, 'picture-in-picture is not modal: the input bar keeps working');
    assert.match(document.body.textContent, /The Map app is in picture-in-picture/);
    const changed = posted.filter((message) => message.method === 'ui/notifications/host-context-changed');
    assert.equal(changed.at(-1).params.displayMode, 'pip');
    assert.deepEqual(changed.at(-1).params.availableDisplayModes, ['inline', 'fullscreen', 'pip']);

    // WHY: one frame floats over a conversation. When another app takes it, this one is back in its card and hears so.
    app.takenByAnotherApp();
    flushSync(); await tick(); flushSync();
    assert.equal(dialog.dataset.mcpAppMode, 'inline');
    assert.equal(document.querySelector('iframe'), iframe);
    assert.equal(posted.filter((message) => message.method === 'ui/notifications/host-context-changed').at(-1).params.displayMode, 'inline');
    assert.doesNotMatch(document.body.textContent, /in picture-in-picture/);

    // The app asks for it, and gets the mode that results; Escape on the title bar returns it to its card.
    fromApp({ id: 2, method: 'ui/request-display-mode', params: { mode: 'pip' } });
    await tick(); flushSync(); await tick();
    assert.deepEqual(posted.find((message) => message.id === 2).result, { mode: 'pip' });
    assert.equal(app.pipKey(), 'activity-1');
    document.querySelector('[aria-label="Return to card"]').parentElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync(); await tick(); flushSync();
    assert.equal(dialog.dataset.mcpAppMode, 'inline');
    assert.equal(app.pipKey(), null);
    assert.equal(stubs.focusRequests, 2);

    // Full screen and back: the same element in the top layer, never a new frame.
    fromApp({ id: 3, method: 'ui/request-display-mode', params: { mode: 'fullscreen' } });
    await tick(); flushSync();
    assert.equal(dialog.dataset.modal, 'true');
    fromApp({ id: 4, method: 'ui/request-display-mode', params: { mode: 'pip' } });
    await tick(); flushSync();
    assert.equal(dialog.dataset.mcpAppMode, 'pip');
    assert.equal(dialog.dataset.modal, undefined);
    assert.equal(document.querySelector('iframe'), iframe);

    // WHY: a pane is legally about 356 px wide. There the frame would not fit: it goes back to its card, and the mode is not offered.
    conversationWidth = 356;
    resize(); flushSync(); await tick(); flushSync();
    assert.equal(dialog.dataset.mcpAppMode, 'inline');
    assert.equal(keepInView(), null);
    fromApp({ id: 5, method: 'ui/request-display-mode', params: { mode: 'pip' } });
    await tick(); flushSync();
    assert.deepEqual(posted.find((message) => message.id === 5).result, { mode: 'inline' });
    assert.deepEqual(posted.filter((message) => message.method === 'ui/notifications/host-context-changed').at(-1).params.availableDisplayModes, ['inline', 'fullscreen']);
    await unmount(app);
  `)
}, 60_000)

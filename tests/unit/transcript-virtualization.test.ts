import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile, compileModule } from 'svelte/compiler'

const directory = mkdtempSync(join(tmpdir(), 'solus-transcript-ui-'))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const root = new URL('../../', import.meta.url)
const client = new URL('node_modules/svelte/src/index-client.js', root).href
const internal = new URL('node_modules/svelte/src/internal/client/index.js', root).href
const transpiler = new Bun.Transpiler({ loader: 'ts' })
const region = 'packages/workspace-ui/src/components/conversation/'

function executable(code: string): string {
  return code.replaceAll(/(['"])svelte\/internal\/client\1/g, JSON.stringify(internal))
    .replaceAll(/(['"])svelte\1/g, JSON.stringify(client))
    .replaceAll(/import ['"]svelte\/internal\/disclose-version['"];?/g, '')
}

test('mounted transcript stays bounded, retains disclosure, and anchors prepend and height changes', async () => {
  const geometryPath = join(directory, 'geometry.mjs')
  writeFileSync(geometryPath, transpiler.transformSync(readFileSync(new URL(region + 'lib/transcript-geometry.ts', root), 'utf8')))
  const controllerPath = join(directory, 'controller.mjs')
  const controllerSource = readFileSync(new URL(region + 'lib/transcript-virtualizer.svelte.ts', root), 'utf8')
    .replace("'./transcript-geometry'", JSON.stringify(geometryPath))
  writeFileSync(controllerPath, executable(compileModule(transpiler.transformSync(controllerSource), {
    filename: 'controller.svelte.js', generate: 'client',
  }).js.code))
  const disclosurePath = join(directory, 'disclosure.mjs')
  writeFileSync(disclosurePath, executable(compileModule(transpiler.transformSync(
    readFileSync(new URL(region + 'lib/transcript-disclosure.svelte.ts', root), 'utf8'),
  ), { filename: 'disclosure.svelte.js', generate: 'client' }).js.code))
  const componentPath = join(directory, 'list.mjs')
  const component = readFileSync(new URL(region + 'VirtualTranscript.svelte', root), 'utf8')
    .replace('"./lib/transcript-virtualizer.svelte"', JSON.stringify(controllerPath))
    .replace('"../../contexts/workspace/startup-transcript"', JSON.stringify(new URL('packages/workspace-ui/src/contexts/workspace/startup-transcript.ts', root).href))
  writeFileSync(componentPath, executable(compile(component, { filename: 'list.svelte', generate: 'client' }).js.code))
  const fixturePath = join(directory, 'fixture.mjs')
  const fixture = `<script>
    import VirtualTranscript from ${JSON.stringify(componentPath)};
    import { provideTranscriptDisclosure, getTranscriptDisclosure } from ${JSON.stringify(disclosurePath)};
    let { scrollElement, virtualizer } = $props();
    let turns = $state(Array.from({ length: 10000 }, (_, index) => ({ id: 'turn-' + index })));
    provideTranscriptDisclosure();
    const disclosure = getTranscriptDisclosure();
    export function expanded() { return disclosure.forKey("turn-0").expanded; }
    export function prepend() { turns.unshift(...Array.from({ length: 100 }, (_, index) => ({ id: 'older-' + index }))); }
  </script>
  <VirtualTranscript tabId="fixture" {turns} {scrollElement} {virtualizer} active>
    {#snippet children(turn)}
      {@const view = disclosure.forKey(turn.id)}
      <button onclick={() => { const view = disclosure.forKey(turn.id); view.expanded = !view.expanded; }}>
        {turn.id}:{view.expanded}
      </button>
    {/snippet}
  </VirtualTranscript>`
  writeFileSync(fixturePath, executable(compile(fixture, { filename: 'fixture.svelte', generate: 'client' }).js.code))
  const testPath = join(directory, 'run.mjs')
  writeFileSync(testPath, `
    import assert from 'node:assert/strict';
    import { JSDOM } from ${JSON.stringify(new URL('node_modules/jsdom/lib/api.js', root).href)};
    const dom = new JSDOM('<!doctype html><body><div id="scroll"></div></body>');
    for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Text', 'Comment', 'Event', 'CustomEvent']) globalThis[key] = dom.window[key];
    const frames = new Map(); let frameId = 0;
    globalThis.requestAnimationFrame = (fn) => { frames.set(++frameId, fn); return frameId; };
    globalThis.cancelAnimationFrame = (id) => frames.delete(id);
    const observers = new Set(); const heights = new Map();
    globalThis.ResizeObserver = class {
      nodes = new Set();
      constructor(callback) { this.callback = callback; observers.add(this); }
      observe(node) { this.nodes.add(node); }
      unobserve(node) { this.nodes.delete(node); }
      disconnect() { observers.delete(this); }
      deliver() { this.callback([...this.nodes].map(target => ({ target, borderBoxSize: [{ blockSize: heights.get(target.dataset.transcriptTurnId) ?? 240 }] }))); }
    };
    const { mount, unmount, flushSync, tick } = await import(${JSON.stringify(client)});
    const { TranscriptVirtualizer } = await import(${JSON.stringify(controllerPath)});
    const { default: Fixture } = await import(${JSON.stringify(fixturePath)});
    const virtualizer = new TranscriptVirtualizer();
    const scroll = document.getElementById('scroll');
    let viewportHeight = 800;
    Object.defineProperty(scroll, 'clientHeight', { get: () => viewportHeight });
    Object.defineProperty(scroll, 'scrollHeight', { get() {
      const content = scroll.querySelector('.messages-list');
      return content ? [...content.children].reduce((sum, node) => sum + (node.dataset.transcriptTurnId
        ? heights.get(node.dataset.transcriptTurnId) ?? 240 : parseFloat(node.style.height) || 0), 0) : 0;
    } });
    let scrollTop = 0;
    Object.defineProperty(scroll, 'scrollTop', { get: () => scrollTop, set(value) { scrollTop = Math.max(0, Math.min(value, scroll.scrollHeight - viewportHeight)); } });
    HTMLElement.prototype.getBoundingClientRect = function() { return { top: this === scroll ? 0 : -scrollTop, height: 800 }; };
    const app = mount(Fixture, { target: scroll, props: { scrollElement: scroll, virtualizer } });
    flushSync(); await tick(); flushSync();
    const drain = async () => {
      for (let pass = 0; pass < 5 && frames.size; pass++) { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(); flushSync(); await tick(); }
    };
    const rows = () => [...document.querySelectorAll('[data-transcript-turn-id]')];
    const move = async (top) => { scroll.scrollTop = top; scroll.dispatchEvent(new Event('scroll')); await drain(); };
    assert.ok(rows().length > 0 && rows().length < 12);
    const firstButton = document.querySelector('button'); firstButton.click(); flushSync();
    assert.equal(app.expanded(), true, 'click updates disclosure state');
    assert.equal(firstButton.textContent.trim(), 'turn-0:true');
    firstButton.focus();
    await move(1200000);
    assert.ok(rows().length < 14);
    assert.ok(document.contains(firstButton));
    firstButton.blur(); await drain();
    assert.ok(!document.contains(firstButton));
    await move(0);
    assert.equal(document.querySelector('button').textContent.trim(), 'turn-0:true');
    await move(1200024);
    const oldTop = scroll.scrollTop;
    app.prepend(); flushSync(); await tick(); flushSync();
    assert.equal(scroll.scrollTop, oldTop + 24000, 'prepending preserves the visible turn and pixel offset');
    heights.set('turn-4999', 600);
    for (const observer of observers) observer.deliver();
    flushSync(); await tick(); flushSync();
    assert.equal(scroll.scrollTop, oldTop + 24000 + 360, 'measuring an overscan row above the viewport preserves its anchor');
    await virtualizer.reveal('turn-9999'); flushSync();
    assert.ok(rows().some(row => row.dataset.transcriptTurnId === 'turn-9999'));
    assert.ok(rows().length < 12);
    viewportHeight = 400;
    for (const observer of observers) observer.deliver();
    flushSync(); await tick(); flushSync();
    await move(800000);
    assert.ok(rows().length < 10, 'a smaller mobile viewport also keeps mounted rows bounded');
    await unmount(app); assert.equal(observers.size, 0);
    dom.window.close();
  `)
  const child = Bun.spawn([process.execPath, testPath], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  expect({ exitCode, stderr, stdout }).toEqual({ exitCode: 0, stderr: '', stdout: '' })
})

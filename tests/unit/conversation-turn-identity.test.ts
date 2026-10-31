import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from 'svelte/compiler'

// WHY: an artifact renders in an iframe, and a re-created iframe loads its page
// again and shows blank until it does. Ending a turn folds its work and moves
// the answer below the summary row; if either moved the artifact or the answer
// into another block, Svelte would rebuild it and the render would flash.
test('ending a turn keeps every on-screen item mounted and folds the work in place', async () => {
  const root = new URL('../../', import.meta.url)
  const directory = mkdtempSync(join(tmpdir(), 'solus-conversation-turn-'))
  const client = new URL('node_modules/svelte/src/index-client.js', root).href
  const internal = new URL('node_modules/svelte/src/internal/client/index.js', root).href
  const turnsModule = new URL('packages/workspace-ui/src/components/conversation/lib/turns.ts', root).pathname
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
    const stub = component('<span></span>', 'stub')
    const turnBody = component(readFileSync(new URL('packages/workspace-ui/src/components/conversation/TurnBody.svelte', root), 'utf8'), 'turn-body')
    // The real turn markup and fold; the rows around the items are stubs.
    const turnSource = readFileSync(new URL('packages/workspace-ui/src/components/conversation/ConversationTurn.svelte', root), 'utf8')
      .replace(/^  import .*?;\n/gm, '')
      .replace(/^  measureMount\(.*?\);\n/m, '')
      .replace('<script lang="ts">', `<script lang="ts">
        import { itemKey, needsLiveRow, shouldAnimateTurnEntry, visibleTurnBody } from ${JSON.stringify(turnsModule)};
        import TurnBody from ${JSON.stringify(turnBody)};
        import Stub from ${JSON.stringify(stub)};
        const BackgroundWorkRow = Stub, TurnActivityRow = Stub, StatusCard = Stub, TurnEndDivider = Stub;
        const ToolInputStatus = Stub, TurnImageGallery = Stub, ToolGroupItem = Stub;
        const describeBackgroundWait = () => null, settledBackgroundWait = () => null;
        const getSettingsContext = () => ({ showToolCalls: true });
      `)
    const turn = component(turnSource, 'turn')
    const fixture = component(`<script>
      import ConversationTurn from ${JSON.stringify(turn)};
      let { liveTurn, settledTurn } = $props();
      let live = $state(true);
      let expanded = $state(false);
    </script>
    <button onclick={() => live = false}>End</button>
    <button onclick={() => expanded = true}>Expand</button>
    {#snippet transcriptItem(item)}<p data-id={item.message.id}>{item.kind}</p>{/snippet}
    <ConversationTurn turn={live ? liveTurn : settledTurn} index={0} total={1} {expanded} isAwaitingInput={false}
      turnStart={null} attempt={1} history={{}} onToggle={() => {}} onRetry={() => {}} {transcriptItem} />`, 'fixture')
    const runner = join(directory, 'run.ts')
    writeFileSync(runner, `
      import assert from 'node:assert/strict';
      import { JSDOM } from ${JSON.stringify(new URL('node_modules/jsdom/lib/api.js', root).href)};
      const dom = new JSDOM('<!doctype html><body></body>');
      for (const key of ['window', 'document', 'Node', 'Element', 'HTMLElement', 'Text', 'Comment', 'Event']) globalThis[key] = dom.window[key];
      const { mount, unmount, flushSync } = await import(${JSON.stringify(client)});
      const { buildTurns, groupMessages } = await import(${JSON.stringify(turnsModule)});
      const { default: Fixture } = await import(${JSON.stringify(fixture)});
      const messages = [
        { id: 'prompt', role: 'user', content: 'chart it', timestamp: 1 },
        { id: 'narration', role: 'assistant', content: 'Building the chart.', timestamp: 2 },
        { id: 'chart', role: 'assistant', content: '', timestamp: 3, artifact: { kind: 'html', html: '<svg></svg>' } },
        { id: 'answer', role: 'assistant', content: 'Here is the chart.', timestamp: 4 },
      ];
      const [liveTurn] = buildTurns(groupMessages(messages), { running: true });
      const [settledTurn] = buildTurns(groupMessages(messages), { running: false });
      const target = document.createElement('div'); document.body.append(target);
      const app = mount(Fixture, { target, props: { liveTurn, settledTurn } });
      flushSync();
      const [end, expand] = target.querySelectorAll('button');
      const item = (id) => target.querySelector('[data-id="' + id + '"]');
      const shown = (el) => !el.closest('[hidden]');
      const narration = item('narration'), chart = item('chart'), answer = item('answer');
      assert.ok(narration && chart && answer && shown(narration) && shown(chart) && shown(answer));

      end.click(); flushSync();
      // The same nodes, still on screen: nothing was rebuilt.
      assert.equal(item('chart'), chart);
      assert.equal(item('answer'), answer);
      assert.ok(shown(chart) && shown(answer));
      // The narration folded in place rather than unmounting.
      assert.equal(item('narration'), narration);
      assert.equal(shown(narration), false);

      expand.click(); flushSync();
      assert.ok(shown(narration));
      assert.equal(item('chart'), chart);
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

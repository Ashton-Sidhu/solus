/**
 * Build an isolated renderer benchmark, without starting a server or reading sessions.
 * Run: bun scripts/measure-session-open.ts [--eager]
 * Load the emitted bundle in an owned browser page and call sessionOpenBenchmark().
 * It executes ConversationView's turn loop with real Markdown and activity rows.
 * Host traffic, input chrome, and rich work cards are outside this measurement.
 * --eager reconstructs the old body mount policy for paired comparisons.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { compile, compileModule } from 'svelte/compiler'

const directory = resolve('.tmp/session-open-benchmark')
mkdirSync(directory, { recursive: true })
const conversation = resolve('packages/workspace-ui/src/components/conversation')
const source = readFileSync(`${conversation}/ConversationView.svelte`, 'utf8')
const start = source.indexOf('{#each turns as turn, turnIdx (turn.id)}')
const end = source.indexOf('            </div>\n          {/if}', start)
if (start < 0 || end < 0) throw new Error('Conversation turn loop not found')
const loop = process.argv.includes('--eager')
  ? source.slice(start, end).replace('<TurnBody visible={live || expanded}>', '').replace('</TurnBody>', '')
  : source.slice(start, end)
const turnBodyImport = source.includes('import TurnBody from')
  ? `import TurnBody from ${JSON.stringify(`${conversation}/TurnBody.svelte`)};` : ''
const toggleStart = source.indexOf('  function toggleTurn(')
const toggleCommand = source.slice(toggleStart, source.indexOf('\n  }', toggleStart) + 4)
writeFileSync(`${directory}/Fixture.svelte`, `<script lang="ts">
  import SvelteMarkdown from '@humanspeak/svelte-markdown';
  import { SvelteMap } from 'svelte/reactivity';
  import ToolGroupItem from '${conversation}/ToolGroupItem.svelte';
  import TurnActivityRow from '${conversation}/TurnActivityRow.svelte';
  import TurnEndDivider from '${conversation}/TurnEndDivider.svelte';
  import ToolInputStatus from '${conversation}/ToolInputStatus.svelte';
  import { buildTurns, groupMessages, hasVisibleTurnBody, itemKey, needsLiveRow, shouldAnimateTurnEntry } from '${conversation}/lib/turns';
  import { agentsAwaitingReply } from '${conversation}/agent-conversation/lib/agent-conversation';
  import { describeBackgroundWait } from '${conversation}/lib/activity-summary';
  ${turnBodyImport}
  let { messages, history = { load: async () => {} } } = $props();
  const turns = $derived(buildTurns(groupMessages(messages), { running: false }));
  const turnExpansion = new SvelteMap();
  const sess = { retryAttempt: 1, currentTurnStart: null };
  const isAwaitingInput = false;
  const activityLabel = undefined;
  const handleRetry = () => {};
  const session = { toolHistory: history };
  const holdAutomaticScroll = () => {};
  ${toggleCommand}
</script>
<div class="cv-list">${loop}</div>
{#snippet transcriptItem(item, skipMotion)}
  {#if item.message?.content}
    <div data-message-id={item.message.id}><SvelteMarkdown source={item.message.content} /></div>
  {/if}
{/snippet}
<style>.turn-body.is-folded { display: none; }</style>`)

writeFileSync(`${directory}/ToolHistoryFixture.svelte`, `<script>
  import Fixture from './Fixture.svelte';
  import { ToolHistoryStore } from '${resolve('packages/workspace-ui/src/contexts/workspace/tool-history.store.ts')}';
  const messages = $state([
    { id: 'prompt', role: 'user', content: 'Check the session loader', timestamp: 1 },
    { id: 'tool', role: 'tool', toolName: 'Read', content: '', timestamp: 2, toolStatus: 'completed',
      historyToolInput: { serverId: 'fixture', sessionId: 'session', provider: 'codex', key: 'input' } },
    { id: 'reply', role: 'assistant', content: 'The session loader is ready.', timestamp: 3 },
  ]);
  globalThis.toolHistoryRequests = [];
  globalThis.toolHistoryMessages = messages;
  const history = new ToolHistoryStore(() => ({ loadSessionToolInputs(request) {
    globalThis.toolHistoryRequests.push(request);
    return new Promise((resolve, reject) => {
      globalThis.completeToolHistoryRead = () => resolve([{ key: 'input', toolInput: '{"file_path":"/fixture/loaded.ts"}' }]);
      globalThis.failToolHistoryRead = () => reject(new Error('Offline fixture'));
    });
  } }));
</script>
<h2>Mobile tool history fixture</h2>
<Fixture {messages} {history} />`)

writeFileSync(`${directory}/entry.ts`, `
import { mount, unmount, flushSync } from 'svelte';
import Fixture from './Fixture.svelte';
import ToolHistoryFixture from './ToolHistoryFixture.svelte';
globalThis.mountToolHistoryFixture = () => {
  const target = document.createElement('div');
  target.dataset.toolHistoryFixture = '';
  target.style.cssText = 'position:fixed;inset:0;overflow:auto;padding:24px;background:var(--background,white);z-index:2147483647';
  document.body.append(target);
  mount(ToolHistoryFixture, { target }); flushSync();
};
const prose = Array.from({ length: 12 }, (_, i) => '### Step ' + i + '\\n\\nInspect **session history**, preserve the input, and check the result.\\n\\n- Read the current state\\n- Apply the change\\n- Verify the result\\n\\n').join('');
function messages() {
  return Array.from({ length: 20 }, (_, turn) => [
    { id: turn + '-user', role: 'user', content: 'Check session ' + turn, timestamp: turn * 10000 },
    { id: turn + '-a', role: 'assistant', content: prose, timestamp: turn * 10000 + 100 },
    { id: turn + '-tool', role: 'tool', content: '', toolName: 'Read', toolInput: '{"file_path":"/fixture/session.ts"}', toolStatus: 'completed', timestamp: turn * 10000 + 200 },
    { id: turn + '-b', role: 'assistant', content: prose, timestamp: turn * 10000 + 300 },
    { id: turn + '-final', role: 'assistant', content: 'Verified session ' + turn + '.', timestamp: turn * 10000 + 400 }
  ]).flat();
}
globalThis.sessionOpenBenchmark = async function () {
  const samples = [];
  for (let run = 0; run < 12; run++) {
    const target = document.createElement('div');
    target.style.cssText = 'position:fixed;inset:0;overflow:auto;background:white;color:black;z-index:2147483647';
    document.body.append(target);
    await new Promise(requestAnimationFrame);
    const start = performance.now();
    const app = mount(Fixture, { target, props: { messages: messages() } });
    flushSync();
    const mountMs = performance.now() - start;
    const nodes = target.querySelectorAll('*').length;
    await new Promise(requestAnimationFrame);
    const frameMs = performance.now() - start;
    const visibleTextLength = target.innerText.length;
    if (run > 1) samples.push({ mountMs, frameMs, nodes, visibleTextLength });
    await unmount(app); target.remove();
  }
  const median = key => {
    const sorted = samples.map(s => s[key]).sort((a,b) => a-b);
    return (sorted[4] + sorted[5]) / 2;
  };
  return { fixture: '100 messages / 20 settled turns; real turn loop, Markdown and activity components', runs: samples.length, medianMountMs: median('mountMs'), medianFrameMs: median('frameMs'), nodes: samples[0].nodes, samples };
};`)
const transpiler = new Bun.Transpiler({ loader: 'ts' })
const result = await Bun.build({
  entrypoints: [`${directory}/entry.ts`], outdir: directory,
  target: 'browser', format: 'iife', conditions: ['browser', 'svelte'], minify: true,
  define: { 'import.meta.env': '{"DEV":false}', 'import.meta.hot': 'undefined' },
  plugins: [{ name: 'svelte-benchmark', setup(build) {
    build.onLoad({ filter: /\.svelte$/ }, ({ path }) => ({
      contents: compile(readFileSync(path, 'utf8'), { filename: path, generate: 'client', dev: false, css: 'injected' }).js.code,
      loader: 'js',
    }))
    build.onLoad({ filter: /\.svelte\.[jt]s$/ }, ({ path }) => ({
      contents: compileModule(transpiler.transformSync(readFileSync(path, 'utf8')), { filename: path, generate: 'client', dev: false }).js.code,
      loader: 'js',
    }))
  } }],
})
if (!result.success) throw new Error(result.logs.join('\n'))
console.log(`${directory}/entry.js`)

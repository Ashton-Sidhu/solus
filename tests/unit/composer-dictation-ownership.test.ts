import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileModule } from 'svelte/compiler'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)

/** Runs a scenario against the real dictation and composer voice code, with
 *  the recorder and the app contexts replaced by small fakes. */
async function runComposerVoice(scenario: string) {
  const production = [
    'lib/dictation.svelte.ts',
    'components/input/lib/composer-voice.svelte.ts',
    'components/input/lib/dictation-text.ts',
  ].map(path => {
    const source = readFileSync(new URL(`packages/workspace-ui/src/${path}`, root), 'utf8')
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
    return ast.statements.filter(statement => !ts.isImportDeclaration(statement))
      .map(statement => statement.getText(ast)).join('\n')
  }).join('\n')
  const harness = `
    import assert from 'node:assert/strict';
    import { untrack, flushSync } from 'svelte';
    let recorder;
    class VoiceRecorder {
      state = $state('idle'); starting = false; error = null; errorKind = null;
      constructor() { recorder = this; }
      start() { this.state = 'recording'; }
      stop() { if (this.state === 'recording') this.state = 'transcribing'; }
      cancel() { this.state = 'idle'; this.onIdle?.(false); }
      result(text) {
        if (this.state !== 'transcribing') return;
        this.onTranscript?.(text); this.state = 'idle'; this.onIdle?.(true);
      }
    }
    const getWorkspaceContext = () => ({ ui: {} });
    const getSettingsContext = () => ({ voiceModeEnabled: false, autoSendVoiceTranscripts: false });
    const getClientShellContext = () => ({ visible: true });
    const hosts = { device: {}, transcription: { voiceReady: true, transcribes: true } };
    class VoiceRetryTracker { canRetry() { return false; } reset() {} }
    const bindings = [];
    const useKeybinding = (id, handler, opts) => bindings.push({ id, handler, opts });
    globalThis.document = { activeElement: null };
    const requestInputFocus = () => {};
    const toasts = {};
    ${production}
${scenario}`
  const directory = mkdtempSync(join(tmpdir(), 'solus-composer-dictation-'))
  try {
    const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(harness)
    const compiled = compileModule(js, { filename: 'composer-dictation.svelte.js', generate: 'client' }).js.code
      .replaceAll(/(['"])svelte\/internal\/client\1/g, JSON.stringify(new URL('node_modules/svelte/src/internal/client/index.js', root).href))
      .replaceAll(/(['"])svelte\1/g, JSON.stringify(new URL('node_modules/svelte/src/index-client.js', root).href))
    const path = join(directory, 'dictation.mjs')
    writeFileSync(path, compiled)
    const child = Bun.spawn([process.execPath, path], { stdout: 'pipe', stderr: 'pipe' })
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('a switched or unmounted composer keeps its transcript until its tab closes', async () => {
  await runComposerVoice(`
    const first = $state({ text: 'first' });
    const second = $state({ text: 'second' });
    let shown = $state('first');
    let firstVoice, secondVoice;
    function mount(owner, draft, ready) {
      return $effect.root(() => ready(useComposerVoice({
        ownerId: () => 'composer:' + owner, prompt: () => draft,
        active: () => shown === owner, isPrimary: () => true,
        isReadOnly: () => false, isConnecting: () => false,
        isBusy: () => false, text: () => draft.text,
        editor: () => ({ insertTranscript(text) { draft.text += ' ' + text; } }),
        sendPrompt: () => { throw new Error('Sent from the wrong composer'); },
      })));
    }
    let closeFirst = mount('first', first, value => firstVoice = value);
    const closeSecond = mount('second', second, value => secondVoice = value);
    flushSync();
    firstVoice.toggle(); flushSync();
    shown = 'second'; flushSync(); closeFirst();
    assert.equal(recorder.state, 'recording');
    secondVoice.toggle(); flushSync();
    assert.equal(recorder.state, 'transcribing');
    recorder.result('recorded'); flushSync();
    assert.deepEqual([first.text, second.text], ['first recorded', 'second']);
    shown = 'first';
    closeFirst = mount('first', first, value => firstVoice = value);
    flushSync(); firstVoice.toggle(); firstVoice.toggle(); flushSync();
    shown = 'second'; flushSync();
    shown = 'first'; flushSync();
    assert.equal(firstVoice.state, 'transcribing');
    recorder.result('returned'); flushSync();
    assert.equal(first.text, 'first recorded returned');
    firstVoice.toggle(); firstVoice.toggle(); flushSync();
    dictation.releaseMessageConsumer('composer:first'); closeFirst();
    recorder.result('late'); flushSync();
    assert.deepEqual([recorder.state, first.text, second.text], ['idle', 'first recorded returned', 'second']);
    closeSecond();
  `)
})

test('the voice shortcut records into the draft, not the session bar hidden under it', async () => {
  // The workspace dock stays mounted and active under a draft that holds the
  // leading pane; only `isPrimary` moves to the draft. The dock mounted first,
  // so it answers the shortcut first unless it steps aside.
  await runComposerVoice(`
    const session = $state({ text: '' });
    const draft = $state({ text: '' });
    let draftOpen = $state(false);
    function mount(owner, prompt, isPrimary) {
      return $effect.root(() => useComposerVoice({
        ownerId: () => 'composer:' + owner, prompt: () => prompt,
        active: () => true, isPrimary,
        isReadOnly: () => false, isConnecting: () => false,
        isBusy: () => false, text: () => prompt.text,
        editor: () => ({ insertTranscript(text) { prompt.text += text; } }),
        sendPrompt: () => false,
      }));
    }
    const shortcut = () => bindings.find(binding =>
      binding.id === 'voice.toggle-recorder' && binding.opts.enabled()).handler();
    const closeDock = mount('session-tab', session, () => !draftOpen);
    flushSync();
    draftOpen = true;
    const closeDraft = mount('draft', draft, () => draftOpen);
    flushSync();
    shortcut(); flushSync();
    shortcut(); flushSync();
    recorder.result('spoken in the draft'); flushSync();
    assert.deepEqual([session.text, draft.text], ['', 'spoken in the draft']);
    closeDraft(); closeDock();
  `)
})

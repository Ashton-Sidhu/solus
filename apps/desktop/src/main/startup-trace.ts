/**
 * Startup phase trace for the packaged app.
 *
 * Off unless `SOLUS_STARTUP_TRACE=1`, so an ordinary launch pays one env read.
 * `scripts/measure-startup.ts` launches the packaged binary with the flag set
 * and parses these lines from stdout — stdout rather than the log file because
 * the log writer buffers, and because a bench run must not append to the
 * installed app's `solus.log`.
 *
 * `performance.now()` is milliseconds since this process's V8 origin, which is
 * after the Electron framework has loaded. The wall-clock field lets the
 * harness anchor the trace to its own spawn time and so account for the
 * framework load the app never sees.
 */
const enabled = process.env.SOLUS_STARTUP_TRACE === '1'

export type StartupPhase =
  | 'main.evaluated'
  | 'app.ready'
  | 'window.created'
  | 'window.shownOnDeadline'
  | 'renderer.domReady'
  | 'renderer.didFinishLoad'
  | 'renderer.ready'
  | 'renderer.mounted'
  | 'core.booted'

export function markStartup(phase: StartupPhase): void {
  if (!enabled) return
  process.stdout.write(`SOLUS_STARTUP ${phase} ${Date.now()} ${performance.now().toFixed(1)}\n`)
}

interface RendererMarks {
  timeOrigin: number
  marks: { name: string; startTime: number }[]
}

/**
 * Fold the renderer's own `solus.boot.*` marks into the same trace.
 *
 * The renderer is most of startup, so a main-process-only trace shows one
 * 1.1-second gap where the interesting work happens. Marks are read once the
 * window is up, over the debug channel rather than the RPC contract: this is a
 * bench read, not a product capability.
 */
export function traceRendererMarks(contents: Electron.WebContents): void {
  if (!enabled) return
  const emitted = new Set<string>()
  const emit = (raw: string) => {
    // SAFETY: the literal expressions below define the returned JSON shape.
    const { timeOrigin, marks } = JSON.parse(raw) as RendererMarks
    for (const mark of marks) {
      if (emitted.has(mark.name)) continue
      emitted.add(mark.name)
      process.stdout.write(
        `SOLUS_STARTUP ${mark.name} ${Math.round(timeOrigin + mark.startTime)} ${mark.startTime.toFixed(1)}\n`,
      )
    }
  }
  const snapshot = `JSON.stringify({timeOrigin:performance.timeOrigin,marks:performance.getEntriesByType('mark')
    .filter(m=>m.name.startsWith('solus.boot.')).map(m=>({name:m.name,startTime:m.startTime}))})`
  void contents.executeJavaScript(snapshot).then(emit).catch(() => {})
  // The window can be ready before history arrives. Observe the later paint
  // mark too, without polling or making the app wait for the trace collector.
  void contents.executeJavaScript(`new Promise(resolve => {
    if (!performance.getEntriesByName('solus.boot.transcript.requested').length ||
        performance.getEntriesByName('solus.boot.transcript.painted').length) {
      resolve(${snapshot}); return;
    }
    const finish = () => { observer.disconnect(); clearTimeout(timeout); resolve(${snapshot}); };
    const observer = new PerformanceObserver(list => {
      if (list.getEntries().some(mark => mark.name === 'solus.boot.transcript.painted')) finish();
    });
    const timeout = setTimeout(finish, 30000);
    observer.observe({type:'mark', buffered:true});
  })`).then(emit).catch(() => {})
}

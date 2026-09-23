import { expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const transpiler = new Bun.Transpiler({ loader: 'ts' })

for (const client of ['desktop', 'web'] as const) {
  test(`${client} mounts and becomes ready while restored history is still pending`, async () => {
    const path = client === 'desktop' ? 'apps/desktop/src/renderer/main.ts' : 'apps/client/src/main.ts'
    const name = client === 'desktop' ? 'boot' : 'connectToServer'
    const source = ts.createSourceFile(path, readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'),
      ts.ScriptTarget.Latest, true)
    const declaration = source.statements.find((statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name)
    if (!declaration) throw new Error(`Missing ${name}`)
    const executable = transpiler.transformSync(declaration.getText(source)).replaceAll('import(', 'loadModule(')
    let finishHistory!: () => void
    const history = new Promise<void>((resolve) => { finishHistory = resolve })
    const mounted = mock(() => ({}))
    const ready = mock(() => {})
    const prefetch = mock(() => history)
    const frames: FrameRequestCallback[] = []
    const target = { id: 'saved-host', local: false, label: 'Saved host', url: 'https://host.example' }
    const transport = { start() {}, destroy() {} }
    const nativeApi = { refreshLocalSessionToken() {}, rendererReady: ready, rendererMounted() {} }
    const dependencies = {
      performance: { mark() {} },
      window: { solusNative: nativeApi },
      getLocalConnection: async () => ({}),
      resolveActiveServerTarget: () => target,
      localServerTarget: () => target,
      savedServerTarget: () => target,
      serverConnections: { registerTarget() {}, registerPrimary() {}, startCatalogSupervisors() {} },
      renderConnecting() {},
      setConnectionState() {},
      installWsBackedSolusApi: () => ({ transport, api: {} }),
      createSolusConnection: () => ({ transport, api: {} }),
      installWindowSolusApi() {},
      prefetchStartupTranscript: prefetch,
      loadModule: async () => ({ mount: mounted, default: {} }),
      loadWorkspaceApp: async () => ({ default: {} }),
      mount: mounted,
      requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length },
      globalThis: { setTimeout() {} },
      toasts: { dismiss() {}, error(message: string) { throw new Error(message) } },
      webPushState: { init() {} },
      installServiceWorkerMessageBridge() {},
      touchLastConnected() {},
      setActiveServerId() {},
      installLogoutListener: ready,
      isStaleBuildError: () => false,
    }
    const run = new Function(...Object.keys(dependencies), `
      let bootTarget, activeTransport, solusApp;
      let connectionGeneration = 0;
      const pendingNotificationRoute = null;
      const root = { innerHTML: '' };
      ${executable}
      return ${name}({ id: 'saved-host' });
    `)
    const boot = run(...Object.values(dependencies))
    try {
      // Drain the resolved module imports without settling history or using timers.
      for (let turn = 0; turn < 12; turn++) await Promise.resolve()
      expect(prefetch).toHaveBeenCalledTimes(1)
      expect(mounted).toHaveBeenCalledTimes(1)
      while (frames.length) frames.shift()!(0)
      expect(ready).toHaveBeenCalledTimes(1)
    } finally {
      finishHistory()
      await boot
    }
    expect(mounted).toHaveBeenCalledTimes(1)
  })
}
